const test = require("node:test");
const assert = require("node:assert/strict");
const { assertPublicHttpUrl } = require("./fetch-page");
const { readSession, setSession, passwordMark } = require("./auth");

test("les adresses internes et les liens piégés sont refusés", async () => {
  const blocked = [
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.1.2.3/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://[::1]/",
    "http://[::ffff:10.1.2.3]/",
    "http://[::ffff:169.254.169.254]/",
    "http://[::ffff:172.16.0.1]/",
    "http://[64:ff9b::10.1.2.3]/",
    "http://[2002:a01:203::1]/",
    "http://[::a01:203]/",
    "http://2130706433/",
    "http://0177.0.0.1/",
    "http://127.1/",
    "http://0x7f000001/",
    "http://user:pass@example.com/",
    "http://metadata.google.internal/",
    "file:///etc/passwd",
  ];
  for (const url of blocked) {
    await assert.rejects(() => assertPublicHttpUrl(url), undefined, url);
  }
});

test("une adresse publique littérale est acceptée", async () => {
  const url = await assertPublicHttpUrl("https://1.1.1.1/chemin");
  assert.equal(url.hostname, "1.1.1.1");
  const v6 = await assertPublicHttpUrl("https://[2001:4860:4860::8888]/");
  assert.match(v6.hostname, /2001:4860:4860::8888/);
});

test("une session ne survit pas au changement de mot de passe", () => {
  const secret = "secret-de-test";
  const res = { setHeader(_name, value) { this.cookie = value; } };
  setSession(res, { secure: true, headers: {} }, secret, "scrypt$ancien");
  const cookie = res.cookie.split(";")[0];
  const payload = readSession({ headers: { cookie } }, secret);
  assert.equal(payload.pw, passwordMark("scrypt$ancien"));
  assert.notEqual(payload.pw, passwordMark("scrypt$nouveau"));
  assert.match(res.cookie, /Secure/);
});
