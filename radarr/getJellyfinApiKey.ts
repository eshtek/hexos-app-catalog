import { HookContext } from "../../hexos-app-catalog/_lib/hook_context";

export interface ApiKey {
  Id: string;
  AccessToken: string;
  AppName: string;
  DateCreated: string;
}

export interface AuthResponse {
  AccessToken: string;
  User: {
    Id: string;
    Policy: { IsAdministrator: boolean };
  };
}

export class JellyfinClient {
  private baseUrl: string;
  private token: string | null = null;

  constructor(baseUrl: string) {
    // Remove trailing slash if provided
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /**
   * Helper to build the required Jellyfin Authorization header.
   */
  private getHeaders(token?: string): Record<string, string> {
    let authHeader = 'MediaBrowser Client="NodeTSApp", Device="Server", DeviceId="unique-device-id", Version="1.0.0"';
    if (token) {
      authHeader += `, Token="${token}"`;
    }
    return {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Authenticates using Username and Password, saving the access token.
   */
  async login(username: string, pw: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/Users/AuthenticateByName`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ Username: username, Pw: pw }),
    });

    if (!response.ok) {
      throw new Error(`Auth failed with status ${response.status}`);
    }

    const data: AuthResponse = await response.json();

    if (!data.User.Policy.IsAdministrator) {
      throw new Error('Authenticated user must be an administrator to manage API keys.');
    }

    this.token = data.AccessToken;
    return this.token;
  }

  /**
   * GET all API keys on the server.
   */
  async getApiKeys(): Promise<ApiKey[]> {
    if (!this.token) throw new Error('Not authenticated. Call login() first.');

    const response = await fetch(`${this.baseUrl}/Auth/Keys`, {
      method: 'GET',
      headers: this.getHeaders(this.token),
    });

    if (!response.ok) throw new Error(`Failed to fetch keys: ${response.status}`);

    const data = await response.json();
    return data.Items ?? [];
  }

  /**
   * CREATE (SET) a new API Key for a specific application name.
   */
  async createApiKey(appName: string): Promise<void> {
    if (!this.token) throw new Error('Not authenticated. Call login() first.');

    const url = `${this.baseUrl}/Auth/Keys?app=${encodeURIComponent(appName)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(this.token),
    });

    if (!response.ok) throw new Error(`Failed to create key: ${response.status}`);
  }
}
export async function getJellyfinApiKey(ctx: HookContext, JELLYFIN_URL: string, JELLYFIN_USERNAME: string, JELLYFIN_PASSWORD: string): Promise<string | null> {
  const jellyfin = new JellyfinClient(JELLYFIN_URL);
 let apiKeyJelly: string | null = null;
  try {
    // 1. Login with credentials

    await jellyfin.login(JELLYFIN_USERNAME, JELLYFIN_PASSWORD);
    ctx.log('Successfully authenticated!');

    // 2. CREATE a new API key
    ctx.log('Creating new API key...');
    try {
        // Key might already exist, so we can ignore errors if it does.
        await jellyfin.createApiKey('radarr-integration');
        ctx.log('API key created successfully.'); 
    } catch (error) {
        ctx.log(`Error creating API key: ${error}`);
    }
    

    // 3. GET all API keys
    ctx.log('Fetching all active API keys...');
    const keys = await jellyfin.getApiKeys();

    apiKeyJelly = keys.find(key => key.AppName === 'radarr-integration')?.AccessToken || null;
    if (!apiKeyJelly) {
        ctx.log('Failed to retrieve the newly created jellyfin API key.');
    }
  } catch (error) {
    ctx.log(`Error: ${error}`);
  }
  return apiKeyJelly;
}
