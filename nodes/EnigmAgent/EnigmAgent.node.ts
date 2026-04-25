import {
	IExecuteFunctions,
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeConnectionType,
	NodeOperationError,
} from 'n8n-workflow';

/**
 * EnigmAgent — main node.
 *
 * Three operations:
 *   - resolve : POST /resolve  { placeholder, origin } -> { value }
 *   - list    : GET  /list                              -> { entries: [...] }
 *   - status  : GET  /status                            -> { status, unlocked }
 *
 * The node never stores secrets in workflow state. The `value` returned by
 * Resolve is intentionally short-lived and meant to be piped directly into
 * the next node (HTTP Request, AI Agent, etc.) — n8n encrypts execution data
 * at rest if database encryption is enabled, but you should also configure
 * the EnigmAgent server with a `--shared-secret` and bind it to localhost.
 */
export class EnigmAgent implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'EnigmAgent',
		name: 'enigmAgent',
		icon: 'file:enigmagent.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description:
			'Resolve encrypted vault secrets at the boundary — LLMs never see real API keys.',
		defaults: {
			name: 'EnigmAgent',
		},
		inputs: [NodeConnectionType.Main],
		outputs: [NodeConnectionType.Main],
		credentials: [
			{
				name: 'enigmAgentApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'resolve',
				options: [
					{
						name: 'Resolve',
						value: 'resolve',
						description:
							'Look up a placeholder in the vault and return its real value (constrained by origin).',
						action: 'Resolve a placeholder to its real secret value',
					},
					{
						name: 'List',
						value: 'list',
						description:
							'List all placeholder entries (names + origins) without revealing values.',
						action: 'List all vault entries',
					},
					{
						name: 'Status',
						value: 'status',
						description:
							'Check whether the EnigmAgent REST server is online and the vault is unlocked.',
						action: 'Get vault status',
					},
				],
			},

			// resolve fields
			{
				displayName: 'Placeholder',
				name: 'placeholder',
				type: 'string',
				default: '',
				placeholder: 'OPENAI_KEY',
				required: true,
				description:
					'Name of the placeholder to resolve, exactly as registered in the EnigmAgent vault. The double-curly form `{{OPENAI_KEY}}` is also accepted; the surrounding braces will be stripped.',
				displayOptions: {
					show: {
						operation: ['resolve'],
					},
				},
			},
			{
				displayName: 'Origin',
				name: 'origin',
				type: 'string',
				default: '',
				placeholder: 'https://api.openai.com',
				required: true,
				description:
					'The origin (scheme + host) the secret will be used against. EnigmAgent enforces that the vault entry was registered for this origin — preventing cross-origin secret leakage even if a placeholder is resolved by mistake.',
				displayOptions: {
					show: {
						operation: ['resolve'],
					},
				},
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
		if (sharedSecret) {
			headers['X-EnigmAgent-Auth'] = sharedSecret;
		}

		// Status / list don't iterate input — they're fired once.
		const operation = this.getNodeParameter('operation', 0) as string;

		if (operation === 'status') {
			const response = await this.helpers.httpRequest({
				method: 'GET',
				url: `${baseUrl}/status`,
				headers,
				json: true,
			});
			returnData.push({ json: response as IDataObject });
			return [returnData];
		}

		if (operation === 'list') {
			const response = await this.helpers.httpRequest({
				method: 'GET',
				url: `${baseUrl}/list`,
				headers,
				json: true,
			});
			returnData.push({ json: response as IDataObject });
			return [returnData];
		}

		// resolve — runs per input item
		for (let i = 0; i < items.length; i++) {
			try {
				let placeholder = (this.getNodeParameter('placeholder', i, '') as string).trim();
				const origin = (this.getNodeParameter('origin', i, '') as string).trim();

				if (!placeholder) {
					throw new NodeOperationError(
						this.getNode(),
						'Placeholder is required for the Resolve operation.',
						{ itemIndex: i },
					);
				}
				if (!origin) {
					throw new NodeOperationError(
						this.getNode(),
						'Origin is required for the Resolve operation. Provide e.g. "https://api.openai.com".',
						{ itemIndex: i },
					);
				}

				// Strip {{ ... }} if the user pasted the double-curly form.
				const wrapped = placeholder.match(/^\{\{\s*([A-Za-z0-9_\-:.]+)\s*\}\}$/);
				if (wrapped) placeholder = wrapped[1];

				const response = (await this.helpers.httpRequest({
					method: 'POST',
					url: `${baseUrl}/resolve`,
					headers,
					body: { placeholder, origin },
					json: true,
				})) as IDataObject;

				returnData.push({
					json: {
						placeholder,
						origin,
						value: response.value,
						resolved: response.value !== undefined && response.value !== null,
					},
					pairedItem: { item: i },
				});
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
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
