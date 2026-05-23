/** Thin, lazily-loaded wrapper over the optional `kerberos` native package. */
export async function generateSpnegoToken(spn: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let kerberos: any;
  try {
    // Dynamic import — kerberos is an optional peer dep, may not be installed
    kerberos = await import('kerberos' as string);
  } catch {
    throw new Error(
      'Kerberos authentication requires the optional "kerberos" package. ' +
        'Install it (needs GSSAPI dev libs on Linux / build tools on Windows): npm i kerberos',
    );
  }
  const client = await kerberos.initializeClient(spn, {});
  await client.step(''); // single-leg: initial AP-REQ
  const token: string | undefined = client.response;
  if (!token) {
    throw new Error('Kerberos: no SPNEGO token produced (no TGT? run kinit, or check SPN).');
  }
  return token;
}
