# Throwaway TLS fixtures

`server.crt` and `server.key` are a self-signed certificate and its private key
for `CN=localhost` (SAN `DNS:localhost`, `IP:127.0.0.1`), used only by
`serverCertificate.test.ts` to stand up a local HTTPS server on `127.0.0.1`.

They are **not secrets**. Nothing trusts this certificate: no CA signed it, no
system or service is configured with it, and the key protects nothing. It is
committed so the test needs no `openssl` at run time (Windows CI included).
Never reuse it for anything else.

Regenerate (valid for 100 years) with:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout server.key -out server.crt \
  -days 36500 -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```
