// Where a server listens, movable while it runs: its page may change the address or port. The new address is bound
// before the old one is let go, so a refused bind (a taken port) leaves the server where it was. The old listener
// stops taking connections but finishes what it has (the request that moved it, open WebSockets).
import type { Server } from "bun";
import { describeError, ValueError } from "./errors";

export interface Listen { host: string; port: number }

export class Listener<T = undefined> {
  server: Server<T>;
  at: Listen;

  /** `serve` binds (Bun.serve with the server's handlers); throws when it cannot */
  constructor(private serve: (at: Listen) => Server<T>, at: Listen) {
    this.server = serve(at);
    this.at = { host: at.host, port: this.server.port ?? at.port };
  }

  /** where a page reaches it: localhost for the loopback address */
  get url(): string { return `http://${this.at.host === "127.0.0.1" ? "localhost" : this.at.host}:${this.at.port}`; }

  /** listen there instead; refused (and still here) when it cannot bind */
  move(to: Listen): void {
    if (to.host === this.at.host && to.port === this.at.port) return;
    const old = this.server, was = this.at;
    let next: Server<T>;
    try {
      next = this.serve(to);
    } catch (e) {
      if (to.port !== was.port) throw new ValueError(`cannot listen on ${to.host}:${to.port}: ${describeError(e)}`);
      old.stop(false);                         // the same port on another address: let it go first
      try { next = this.serve(to); } catch (e2) {
        this.server = this.serve(was);
        throw new ValueError(`cannot listen on ${to.host}:${to.port}: ${describeError(e2)}`);
      }
    }
    this.server = next;
    this.at = { host: to.host, port: next.port ?? to.port };
    setTimeout(() => void old.stop(false), 500);   // after the answer to the request that moved it
  }

  stop(): void { this.server.stop(true); }
}
