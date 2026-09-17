import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { Store } from "../core/store.js";
import type { HttpConfig } from "./config.js";

export interface PlayerIdentity {
  playerId: string;
  expiresAtMs: number;
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const safeEqual = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));

/** No forwarded headers are trusted. Limits key on the socket peer and a global bucket. */
export class AccessLimiter {
  private readonly peers = new Map<string, { count: number; until: number }>();
  private global = { count: 0, until: 0 };
  constructor(private readonly now = Date.now) {}
  take(peer: string): boolean {
    const now = this.now();
    for (const [key, item] of this.peers)
      if (item.until <= now) this.peers.delete(key);
    if (this.global.until <= now)
      this.global = { count: 0, until: now + 600_000 };
    let item = this.peers.get(peer);
    if (!item) {
      if (this.peers.size >= 1024) return false;
      item = { count: 0, until: now + 600_000 };
      this.peers.set(peer, item);
    }
    if (this.global.count >= 60 || item.count >= 20) return false;
    this.global.count++;
    item.count++;
    return true;
  }
}

export class CloudAuth {
  constructor(
    private readonly store: Store,
    private readonly config: HttpConfig,
    private readonly now = Date.now,
  ) {}
  private sign(token: string): string {
    return createHmac("sha256", this.config.cookieSecret!)
      .update(`last-mile-player:${token}`)
      .digest("base64url");
  }
  async identify(cookie: string | undefined): Promise<PlayerIdentity | null> {
    if (!cookie || !/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(cookie))
      return null;
    const [token, signature] = cookie.split(".") as [string, string];
    if (!safeEqual(signature, this.sign(token))) return null;
    const row = await this.store.one(
      "SELECT player_id, expires_at_ms FROM cloud_credentials WHERE token_hash = ?",
      hash(token),
    );
    if (!row || Number(row.expires_at_ms) <= this.now()) return null;
    return { playerId: row.player_id, expiresAtMs: Number(row.expires_at_ms) };
  }
  validInvite(value: string): boolean {
    return safeEqual(value, this.config.inviteCode!);
  }
  async issue(): Promise<{ cookie: string; identity: PlayerIdentity }> {
    const token = randomBytes(32).toString("base64url");
    const playerId = randomUUID();
    const createdAtMs = this.now();
    const expiresAtMs = createdAtMs + 14 * 24 * 60 * 60 * 1000;
    await this.store.transaction(async () => {
      await this.store.insert("cloud_players", {
        player_id: playerId,
        created_at_ms: createdAtMs,
      });
      await this.store.insert("cloud_credentials", {
        token_hash: hash(token),
        player_id: playerId,
        expires_at_ms: expiresAtMs,
      });
    });
    return {
      cookie: `${this.config.cookieName}=${token}.${this.sign(token)}; Path=/api/v1; HttpOnly; Secure; SameSite=Strict; Max-Age=1209600`,
      identity: { playerId, expiresAtMs },
    };
  }
}
