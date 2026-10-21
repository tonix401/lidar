// REST API client: GET variables, POST variables/methods with SICK's challenge-response auth.
import { createHash } from "node:crypto";
import { DEFAULT_IP } from "./variables";

/** the device answered, but reported an error for this variable or method */
export class RestError extends Error { override name = "RestError"; }

interface Challenge { realm: string; nonce: string; opaque?: string; salt?: number[] }

export class RestClient {
  static readonly USER_LEVELS = ["Run", "Operator", "Maintenance", "AuthorizedClient", "Service"] as const;
  readonly base: string;
  user = "Run";
  private password = "";

  constructor(ip: string = DEFAULT_IP, private timeoutS = 5, baseUrl?: string) {
    this.base = baseUrl ?? `http://${ip}/api/`;
  }

  private async request(name: string, body?: unknown): Promise<Record<string, any>> {
    const r = await fetch(this.base + name, {
      method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(this.timeoutS * 1000),
    });
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} ${r.statusText}`), { name: "HTTPError" });
    return (await r.json()) as Record<string, any>;
  }

  /** read one variable and return its value */
  async get(name: string): Promise<unknown> {
    const res = await this.request(name);
    if (res.header.status !== 0) throw new RestError(`${name}: ${res.header.message} (status ${res.header.status})`);
    if (!(name in (res.data ?? {}))) throw new RestError(`${name}: missing in the reply`);
    return res.data[name];
  }

  /** Read several variables. A variable the device rejects is reported in place and the rest are still read; a
   *  connection problem (timeout, refused, ...) throws at once instead of waiting out one timeout per variable. */
  async getMany(names: string[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const n of names) {
      try {
        out[n] = await this.get(n);
      } catch (e) {
        if (!(e instanceof RestError || e instanceof SyntaxError)) throw e;      // device answered, but not with this variable
        out[n] = `<error: ${e.message}>`;
      }
    }
    return out;
  }

  // --- authenticated POST ---

  /** set the user level for subsequent POSTs. Default passwords of SICK LiDARs are typically "client"
   *  (AuthorizedClient) and "servicelevel" (Service). */
  async login(user: string, password: string): Promise<boolean> {
    this.user = user; this.password = password;
    const ok = (await this.post("checkCredentials", undefined)).header.status === 0;
    if (!ok) { this.user = "Run"; this.password = ""; }
    return ok;
  }

  write(name: string, value: unknown): Promise<Record<string, any>> { return this.post(name, { [name]: value }); }

  call(method: string, args?: unknown): Promise<Record<string, any>> { return this.post(method, args); }

  /** SHA-256 digest auth: H(H(user:realm:password[:salt]) : nonce : H(POST:name)) */
  static challengeResponse(user: string, password: string, ch: Challenge, name: string): string {
    const h1 = [...Buffer.from(`${user}:${ch.realm}:`), ...[...password].map(c => c.charCodeAt(0) % 256)];
    if (ch.salt) h1.push(":".charCodeAt(0), ...ch.salt);
    const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
    return sha(`${sha(Uint8Array.from(h1))}:${ch.nonce}:${sha(`POST:${name}`)}`);
  }

  private async post(name: string, data: unknown): Promise<Record<string, any>> {
    const ch = (await this.request("getChallenge", { data: { user: this.user } })).challenge as Challenge;
    const header = { user: this.user, realm: ch.realm, nonce: ch.nonce, opaque: ch.opaque,
                     response: RestClient.challengeResponse(this.user, this.password, ch, name) };
    return this.request(name, data === undefined ? { header } : { header, data });
  }
}
