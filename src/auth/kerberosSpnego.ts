/** Thin, lazily-loaded wrapper over the optional `kerberos` native package. */
export async function generateSpnegoToken(spn: string): Promise<string> {
  // optional peer dep; typed as any because the module/types may be absent
  let kerberos: any;
  try {
    // @ts-expect-error optional peer dependency — module may be absent at build time (TS2307)
    kerberos = await import('kerberos');
  } catch {
    throw new Error(
      'Kerberos authentication requires the optional "kerberos" package. ' +
        'Install it (needs GSSAPI dev libs on Linux / build tools on Windows): npm i kerberos',
    );
  }
  const client = await kerberos.initializeClient(spn, {});
  await client.step('');
  const token = (client as unknown as { response?: string }).response;
  if (!token) {
    throw new Error(
      'Kerberos: no SPNEGO token produced (no TGT? run kinit, or check SPN).',
    );
  }
  return token;
}
