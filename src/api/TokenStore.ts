import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

interface TokenFile {
  version: 1;
  refreshToken: string;
  /** sha256 of the config token this chain started from, so a newly pasted config token wins. */
  configFingerprint?: string;
  updatedAt: string;
}

const fingerprint = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Persists Xfinity's rotating refresh token.
 *
 * Xfinity issues a new refresh token on every refresh and may invalidate the old one.
 * The original plugin never read the rotated token back, so every restart reused the
 * stale token from config.json. This store is the single source of truth instead.
 */
export class TokenStore {
  private current?: string;
  private configFp?: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly onError: (err: unknown) => void = () => undefined,
    /** older token file locations, read once if the main file doesn't exist yet */
    private readonly legacyFiles: string[] = [],
  ) {}

  /** Decide which refresh token to start with. */
  async load(configToken?: string): Promise<string | undefined> {
    let saved = await this.read(this.file);
    let migrated = false;
    for (const legacy of saved ? [] : this.legacyFiles) {
      saved = await this.read(legacy);
      if (saved) {
        migrated = true;
        break;
      }
    }
    const cfg = configToken?.trim() || undefined;
    this.configFp = cfg ? fingerprint(cfg) : saved?.configFingerprint;

    if (cfg && saved?.configFingerprint !== this.configFp) {
      // User pasted a new token into config: start a fresh chain from it.
      this.current = cfg;
      await this.save(cfg);
    } else {
      this.current = saved?.refreshToken ?? cfg;
      if (migrated && this.current) {
        await this.save(this.current); // keep the chain going in the new location
      }
    }
    return this.current;
  }

  get token(): string | undefined {
    return this.current;
  }

  /** Store a rotated token. Writes are serialized and atomic (tmp file + rename, mode 600). */
  save(token: string): Promise<void> {
    this.current = token;
    const data: TokenFile = {
      version: 1, refreshToken: token, configFingerprint: this.configFp, updatedAt: new Date().toISOString(),
    };
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
      await fs.rename(tmp, this.file);
      await fs.chmod(this.file, 0o600);
    }).catch(err => this.onError(err));
    return this.writeChain;
  }

  private async read(file: string): Promise<TokenFile | undefined> {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as TokenFile;
      return typeof parsed.refreshToken === 'string' && parsed.refreshToken ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
}
