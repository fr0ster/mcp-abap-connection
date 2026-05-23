import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCertificateMaterialLoader } from '../../auth/FileCertificateMaterialLoader.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'certtest-'));
  writeFileSync(join(dir, 'c.crt'), 'CERT');
  writeFileSync(join(dir, 'c.key'), 'KEY');
  writeFileSync(join(dir, 'c.pfx'), Buffer.from([1, 2, 3]));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const loader = new FileCertificateMaterialLoader();

test('loads PEM cert+key', async () => {
  const m = await loader.load({
    url: 'https://h',
    authType: 'certificate',
    certPath: join(dir, 'c.crt'),
    certKeyPath: join(dir, 'c.key'),
  } as any);
  expect(m.cert?.toString()).toBe('CERT');
  expect(m.key?.toString()).toBe('KEY');
});
test('loads PFX with passphrase', async () => {
  const m = await loader.load({
    url: 'https://h',
    authType: 'certificate',
    certPfxPath: join(dir, 'c.pfx'),
    certPassphrase: 'pw',
  } as any);
  expect(m.pfx).toBeInstanceOf(Buffer);
  expect(m.passphrase).toBe('pw');
});
test('throws when both PEM and PFX given', async () => {
  await expect(
    loader.load({
      url: 'https://h',
      authType: 'certificate',
      certPath: join(dir, 'c.crt'),
      certPfxPath: join(dir, 'c.pfx'),
    } as any),
  ).rejects.toThrow();
});
