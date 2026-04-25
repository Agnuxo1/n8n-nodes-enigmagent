import {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

/**
 * EnigmAgent API credentials.
 *
 * The user runs the EnigmAgent MCP in REST mode locally (or in a private
 * network) via:
 *
 *     npx enigmagent-mcp --mode rest --port 3737
 *
 * The vault is unlocked once with a master passphrase on the user's machine.
 * n8n nodes only ever see opaque placeholder tokens — never the real secret.
 *
 * Optional `sharedSecret` is sent as `X-EnigmAgent-Auth` header so the REST
 * endpoint can refuse traffic that does not come from a trusted n8n instance.
 */
export class EnigmAgentApi implements ICredentialType {
	name = 'enigmAgentApi';
	displayName = 'EnigmAgent API';
	documentationUrl = 'https://github.com/Agnuxo1/EnigmAgent';

	properties: INodeProperties[] = [
		{
			displayName: 'EnigmAgent REST URL',
			name: 'url',
			type: 'string',
			default: 'http://localhost:3737',
			placeholder: 'http://localhost:3737',
			required: true,
			description:
				'Base URL where `npx enigmagent-mcp --mode rest` is listening. Usually `http://localhost:3737`. Use a private LAN address or Tailscale IP for shared n8n instances.',
		},
		{
			displayName: 'Shared Secret (optional)',
			name: 'sharedSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'If your EnigmAgent REST server is started with `--shared-secret <token>`, set the same token here. It is sent as the `X-EnigmAgent-Auth` header on every request.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				'X-EnigmAgent-Auth': '={{$credentials.sharedSecret}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.url}}',
			url: '/status',
			method: 'GET',
		},
	};
}
