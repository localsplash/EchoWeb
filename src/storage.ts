import { promises as fs } from 'fs';
import path from 'path';

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export class InboundStorage {
  private readonly lostEventDir: string;
  private readonly errorDir: string;

  constructor(private readonly dir: string) {
    this.lostEventDir = path.join(this.dir, 'lostEvent');
    this.errorDir = path.join(this.dir, 'error');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.mkdir(this.lostEventDir, { recursive: true });
    await fs.mkdir(this.errorDir, { recursive: true });
  }

  filePathForId(id: string): string {
    return path.join(this.dir, `${sanitizeId(id)}.json`);
  }

  async saveIfNew(id: string, payload: unknown): Promise<'stored' | 'duplicate'> {
    const file = this.filePathForId(id);
    try {
      await fs.access(file);
      return 'duplicate';
    } catch {
      await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
      return 'stored';
    }
  }

  async list(): Promise<Array<{ id: string; file: string; createdAt: string }>> {
    const entries = await fs.readdir(this.dir);
    const items = await Promise.all(entries.filter((f) => f.endsWith('.json')).map(async (file) => {
      const stat = await fs.stat(path.join(this.dir, file));
      return {
        id: file.replace(/\.json$/, ''),
        file,
        createdAt: stat.birthtime.toISOString()
      };
    }));

    return items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async open(id: string): Promise<unknown> {
    const file = this.filePathForId(id);
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  }

  async saveLostEvent(id: string, payload: unknown): Promise<void> {
    const file = path.join(this.lostEventDir, `${Date.now()}_${sanitizeId(id)}.json`);
    await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
  }

  async saveError(payload: unknown): Promise<void> {
    const file = path.join(this.errorDir, `${Date.now()}_error.json`);
    await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
  }
}
