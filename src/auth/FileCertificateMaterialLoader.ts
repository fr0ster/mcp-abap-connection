import { readFile } from 'node:fs/promises';
import type {
  ICertificateMaterial,
  ICertificateMaterialLoader,
  ISapConfig,
} from '@mcp-abap-adt/interfaces';

export class FileCertificateMaterialLoader implements ICertificateMaterialLoader {
  async load(config: ISapConfig): Promise<ICertificateMaterial> {
    const hasPem = !!(config.certPath || config.certKeyPath);
    const hasPfx = !!config.certPfxPath;
    if (hasPem && hasPfx) {
      throw new Error(
        'Certificate auth: provide either PEM (certPath+certKeyPath) OR certPfxPath, not both.',
      );
    }
    if (hasPfx) {
      return { pfx: await readFile(config.certPfxPath as string), passphrase: config.certPassphrase };
    }
    if (config.certPath && config.certKeyPath) {
      return {
        cert: await readFile(config.certPath),
        key: await readFile(config.certKeyPath),
        passphrase: config.certPassphrase,
      };
    }
    throw new Error('Certificate auth requires certPfxPath OR (certPath AND certKeyPath).');
  }
}
