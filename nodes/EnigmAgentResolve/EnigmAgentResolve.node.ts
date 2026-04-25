import {
	IExecuteFunctions,
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeConnectionTypes,
} from 'n8n-workflow';

/**
 * EnigmAgent Substitute — sugar node.
 *
 * Walks every string inside the input JSON, finds occurrences of
 * `{{PLACEHOLDER}}`, asks the EnigmAgent REST server to resolve each
 * placeholder for the given `originUrl`, and replaces the literal
 * `{{PLACEHOLDER}}` substring with the real secret value.
 *
 * Designed to live BETWEEN an upstream node that produces a templated
 * payload (e.g. an LLM that drafts an HTTP request body or a Set node
 * with header templates) and the actual outbound HTTP Request node.
 *
 * Resolved values are cached for the lifetime of the execute() call so we
 * don't hit /resolve more than once per unique placeholder per item.
 */
export class EnigmAgentResolve implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'EnigmAgent Substitute',
		name: 'enigmAgentResolve',
		icon: 'file:../EnigmAgent/enigmagent.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["originUrl"]}}',
		description:
			'Substitute every {{PLACEHOLDER}} in the input JSON with the real value resolved by EnigmAgent. Place this between an LLM/templating node and the outbound HTTP Request.',
		defaults: {
			name: 'EnigmAgent Substitute',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'enigmAgentApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Origin URL',
				name: 'originUrl',
				type: 'string',
				default: '',
				placeholder: 'https://api.openai.com',
				required: true,
				description:
					'The single origin all placeholders in this batch will be resolved against. EnigmAgent verifies the vault entry was registered for this origin.',
			},
			{
				displayName: 'Field Names To Substitute (optional)',
				name: 'targetFields',
				type: 'string',
				default: '',
				placeholder: 'headers, body, url',
				description:
					'Comma-separated list of top-level keys to walk. Leave empty to walk every string in the entire input object.',
			},
			{
				displayName: 'Fail On Unresolved',
				name: 'failOnUnresolved',
				type: 'boolean',
				default: true,
				description:
					'Whether to fail the node if any {{PLACEHOLDER}} cannot be resolved. Disable to leave unresolved tokens untouched in the output.',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const credentials = await this.getCredentials('enigmAgentApi');
		const baseUrl = String(credentials.url || 'http://localhost:3737').replace(/\/+$/, '');
		const sharedSecret = String(credentials.sharedSecret || '');

		const headers: IDataObject = {
			'Content-Type': 'application/json',
			Accept: 'application/json',
		};
		if (sharedSecret) headers['X-EnigmAgent-Auth'] = sharedSecret;

		const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_\-:.]+)\s*\}\}/g;

		for (let i = 0; i < items.length; i++) {
			try {
				const originUrl = (this.getNodeParameter('originUrl', i, '') as string).trim();
				const targetFieldsRaw = (this.getNodeParameter('targetFields', i, '') as string).trim();
				const failOnUnresolved = this.getNodeParameter('failOnUnresolved', i, true) as boolean;
				const targetFields = targetFieldsRaw
					? targetFieldsRaw.split(',').map((s) => s.trim()).filter(Boolean)
					: [];

				const cache = new Map<string, string | null>();

				const resolveOne = async (name: string): Promise<string | null> => {
					if (cache.has(name)) return cache.get(name) ?? null;
					try {
						const r = (await this.helpers.httpRequest({
							method: 'POST',
							url: `${baseUrl}/resolve`,
							headers,
							body: { placeholder: name, origin: originUrl },
							json: true,
						})) as IDataObject;
						const v = (r.value ?? null) as string | null;
						cache.set(name, v);
						return v;
					} catch {
						cache.set(name, null);
						return null;
					}
				};

				const substituteString = async (s: string): Promise<string> => {
					const matches = [...s.matchAll(PLACEHOLDER_RE)];
					if (matches.length === 0) return s;

					// Resolve each unique placeholder once
					const unique = Array.from(new Set(matches.map((m) => m[1])));
					const resolved: Record<string, string | null> = {};
					for (const name of unique) {
						resolved[name] = await resolveOne(name);
					}

					return s.replace(PLACEHOLDER_RE, (full, name: string) => {
						const v = resolved[name];
						if (v === null || v === undefined) {
							if (failOnUnresolved) {
								throw new Error(
									`EnigmAgent: could not resolve placeholder ${full} for origin ${originUrl}.`,
								);
							}
							return full;
						}
						return v;
					});
				};

				const walk = async (value: unknown): Promise<unknown> => {
					if (typeof value === 'string') {
						return substituteString(value);
					}
					if (Array.isArray(value)) {
						const out: unknown[] = [];
						for (const v of value) out.push(await walk(v));
						return out;
					}
					if (value && typeof value === 'object') {
						const out: Record<string, unknown> = {};
						for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
							out[k] = await walk(v);
						}
						return out;
					}
					return value;
				};

				const original = items[i].json as IDataObject;
				let next: IDataObject;

				if (targetFields.length === 0) {
					next = (await walk(original)) as IDataObject;
				} else {
					next = { ...original };
					for (const field of targetFields) {
						if (field in next) {
							next[field] = (await walk(next[field])) as IDataObject[keyof IDataObject];
						}
					}
				}

				returnData.push({
					json: next,
					pairedItem: { item: i },
				});
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { ...(items[i].json as IDataObject), _enigmaError: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}
