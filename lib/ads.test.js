const test = require("node:test");
const assert = require("node:assert/strict");
const { parseClient, parseSlot, adsTxtLine, slotAfter, saveAds, publicAds, adsTxtBody } = require("./ads");

function memoryDb() {
  const store = new Map();
  return {
    async query(sql, params = []) {
      if (sql.startsWith("SELECT")) {
        const value = store.get(params[0]);
        return { rows: value == null ? [] : [{ value }] };
      }
      if (sql.startsWith("INSERT")) {
        store.set(params[0], params[1]);
        return { rows: [] };
      }
      if (sql.startsWith("DELETE")) {
        const key = sql.match(/key = '([^']+)'/)?.[1];
        if (key) store.delete(key);
        return { rows: [] };
      }
      throw new Error(sql);
    },
  };
}

test("un identifiant éditeur incomplet est refusé", () => {
  assert.equal(parseClient("ca-pub-1234567890123456"), "ca-pub-1234567890123456");
  assert.equal(parseClient("pub-1234567890123456"), "");
  assert.equal(parseClient("ca-pub-abc"), "");
  assert.equal(parseSlot("1234567890"), "1234567890");
  assert.equal(parseSlot("slot-1"), "");
});

test("ads.txt reprend le numéro éditeur sans le préfixe ca-", () => {
  assert.equal(
    adsTxtLine("ca-pub-1234567890123456"),
    "google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0"
  );
  assert.equal(adsTxtLine(""), "");
});

test("une publicité toutes les 9 cartes, trois au plus", () => {
  assert.deepEqual(slotAfter(8), []);
  assert.deepEqual(slotAfter(9), [9]);
  assert.deepEqual(slotAfter(20), [9, 18]);
  assert.deepEqual(slotAfter(40), [9, 18, 27]);
});

test("coupée, la publicité ne sort ni dans l’agenda ni dans ads.txt", async () => {
  const db = memoryDb();
  const saved = await saveAds(db, { enabled: false, client: "ca-pub-1234567890123456", slot: "1234567890" });
  assert.equal(saved.enabled, false);
  assert.equal(saved.live, false);
  assert.equal(await publicAds(db), null);
  assert.equal(await adsTxtBody(db), "");
  await assert.rejects(() => saveAds(db, { enabled: true, client: "", slot: "" }), /Pour activer/);
  const live = await saveAds(db, { enabled: true, client: "ca-pub-1234567890123456", slot: "1234567890" });
  assert.equal(live.live, true);
  assert.deepEqual(await publicAds(db), { client: "ca-pub-1234567890123456", slot: "1234567890" });
  assert.match(await adsTxtBody(db), /^google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0\n$/);
  const off = await saveAds(db, { enabled: false, client: "ca-pub-1234567890123456", slot: "1234567890" });
  assert.equal(off.live, false);
  assert.equal(await publicAds(db), null);
});
