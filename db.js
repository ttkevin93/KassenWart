/*
 * Copyright (c) 2026 Kevin Schmitz
 * SPDX-License-Identifier: GPL-3.0-only
 */

// IndexedDB helper (small-data friendly, no external libs)
const DB_NAME = "kassenwart_db";
const DB_VERSION = 1;
let dbPromise = null;
let activeDb = null;

function idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = req.result;
      console.warn("[openDb] onupgradeneeded!", {
        oldVersion: e.oldVersion,
        newVersion: e.newVersion,
        dbName: db.name,
        href: location.href
      });

      // users: keyPath id (4-digit)
      if (!db.objectStoreNames.contains("users")) {
        const s = db.createObjectStore("users", { keyPath: "id" });
        s.createIndex("active", "active", { unique: false });
        s.createIndex("name", "name", { unique: false });
      }

      // products: keyPath id
      if (!db.objectStoreNames.contains("products")) {
        const s = db.createObjectStore("products", { keyPath: "id" });
        s.createIndex("active", "active", { unique: false });
        s.createIndex("sortOrder", "sortOrder", { unique: false });
      }

      // txns: keyPath id
      if (!db.objectStoreNames.contains("txns")) {
        const s = db.createObjectStore("txns", { keyPath: "id" });
        s.createIndex("userId", "userId", { unique: false });
        s.createIndex("ts", "ts", { unique: false });
      }

      // payments: keyPath id
      if (!db.objectStoreNames.contains("payments")) {
        const s = db.createObjectStore("payments", { keyPath: "id" });
        s.createIndex("userId", "userId", { unique: false });
        s.createIndex("ts", "ts", { unique: false });
      }

      // price_history: keyPath id
      if (!db.objectStoreNames.contains("price_history")) {
        const s = db.createObjectStore("price_history", { keyPath: "id" });
        s.createIndex("productId", "productId", { unique: false });
        s.createIndex("ts", "ts", { unique: false });
      }

      // settings: keyPath key
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }

    };

    req.onblocked = () => {
      console.warn("[openDb] Öffnen blockiert. Bitte andere App-Tabs schließen.");
    };

    req.onerror = () => {
      dbPromise = null;
      reject(req.error || new Error("IndexedDB konnte nicht geöffnet werden."));
    };

    req.onsuccess = () => {
      const db = req.result;
      activeDb = db;
      const releaseConnection = () => {
        if (activeDb !== db) return;
        activeDb = null;
        dbPromise = null;
      };

      db.onversionchange = () => {
        db.close();
        releaseConnection();
      };

      // Wird nicht von allen älteren WebViews unterstützt, ist dort aber harmlos.
      db.onclose = releaseConnection;

      console.log("[openDb] opened", {
        name: db.name,
        version: db.version,
        stores: Array.from(db.objectStoreNames),
        href: location.href
      });
      resolve(db);
    };
  });

  return dbPromise;
}

async function withStore(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const out = fn(store, tx);
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error(`IndexedDB-Transaktion abgebrochen: ${storeName}`));
  });
}

const DB = {
  async get(store, key) {
    const db = await openDb();
    return idbReq(db.transaction(store, "readonly").objectStore(store).get(key));
  },
  async put(store, value) {
    return withStore(store, "readwrite", (s) => s.put(value));
  },
  async add(store, value) {
    return withStore(store, "readwrite", (s) => s.add(value));
  },
  async delete(store, key) {
    return withStore(store, "readwrite", (s) => s.delete(key));
  },
  async getAll(store) {
    const db = await openDb();
    return idbReq(db.transaction(store, "readonly").objectStore(store).getAll());
  },
  async count(store) {
    const db = await openDb();
    return idbReq(db.transaction(store, "readonly").objectStore(store).count());
  },
  async clearStore(storeName){
    const db = await openDb();
    return new Promise((resolve,reject)=>{
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).clear();
      tx.oncomplete = ()=> resolve(true);
      tx.onerror = ()=> reject(tx.error);
      tx.onabort = ()=> reject(tx.error || new Error(`IndexedDB-Transaktion abgebrochen: ${storeName}`));
    });
  },

  async getAllByIndex(store, indexName, value) {
    const db = await openDb();
    const tx = db.transaction(store, "readonly");
    const idx = tx.objectStore(store).index(indexName);
    return idbReq(idx.getAll(value));
  },
  async getAllByIndexRange(store, indexName, lower=null, upper=null) {
    const db = await openDb();
    const tx = db.transaction(store, "readonly");
    const idx = tx.objectStore(store).index(indexName);
    let range = null;
    if (lower != null && upper != null) range = IDBKeyRange.bound(lower, upper);
    else if (lower != null) range = IDBKeyRange.lowerBound(lower);
    else if (upper != null) range = IDBKeyRange.upperBound(upper);
    return idbReq(range ? idx.getAll(range) : idx.getAll());
  },
  async getFirstByIndex(store, indexName) {
    const db = await openDb();
    const tx = db.transaction(store, "readonly");
    const idx = tx.objectStore(store).index(indexName);
    return new Promise((resolve, reject) => {
      const req = idx.openCursor();
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => reject(req.error);
    });
  },
  async getLastByIndex(store, indexName, limit=20) {
    const db = await openDb();
    const tx = db.transaction(store, "readonly");
    const idx = tx.objectStore(store).index(indexName);
    return new Promise((resolve, reject) => {
      const values = [];
      const req = idx.openCursor(null, "prev");
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || values.length >= limit) {
          resolve(values);
          return;
        }
        values.push(cursor.value);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  },
  async bookProductAtomic({ id, userId, productId, ts }) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["txns", "products"], "readwrite");
      const products = tx.objectStore("products");
      const txns = tx.objectStore("txns");
      let result = { ok:false, reason:"missing" };

      const req = products.get(productId);
      req.onsuccess = () => {
        const product = req.result;
        if (!product || !product.active) {
          result = { ok:false, reason:"inactive" };
          return;
        }
        if (product.trackStock && (product.stock || 0) <= 0) {
          result = { ok:false, reason:"out", product };
          return;
        }

        const txn = {
          id,
          userId,
          productId,
          priceCents: product.priceCents,
          ts,
          voidedAt: null
        };
        if (product.trackStock) {
          product.stock = (product.stock || 0) - 1;
          products.put(product);
        }
        txns.put(txn);
        result = { ok:true, txn, product };
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Buchungstransaktion abgebrochen."));
    });
  },
  async resetTestUserAtomic(userId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["users", "txns", "payments", "products"], "readwrite");
      const users = tx.objectStore("users");
      const txns = tx.objectStore("txns");
      const payments = tx.objectStore("payments");
      const products = tx.objectStore("products");
      let specificError = null;
      let result = null;
      const loaded = {};
      let pending = 4;

      const fail = error => {
        specificError = error instanceof Error ? error : new Error(String(error));
        try { tx.abort(); } catch (_) {}
      };
      const ready = () => {
        pending -= 1;
        if (pending !== 0) return;
        const user = loaded.user;
        if (!user?.isTestUser) {
          fail(new Error("Nutzer ist nicht als Testnutzer markiert."));
          return;
        }
        const stockReturns = new Map();
        let revenueCents = 0;
        for (const txn of loaded.txns) {
          if (!txn.voidedAt) {
            revenueCents += Number(txn.priceCents) || 0;
            stockReturns.set(txn.productId, (stockReturns.get(txn.productId) || 0) + 1);
          }
          txns.delete(txn.id);
        }
        for (const payment of loaded.payments) payments.delete(payment.id);
        for (const product of loaded.products) {
          const amount = stockReturns.get(product.id) || 0;
          if (amount > 0 && product.trackStock) {
            product.stock = (Number(product.stock) || 0) + amount;
            products.put(product);
          }
        }
        result = {
          userId: user.id,
          userName: user.name,
          txnCount: loaded.txns.length,
          paymentCount: loaded.payments.length,
          revenueCents,
          paymentCents: loaded.payments
            .filter(payment => !payment.voidedAt)
            .reduce((sum, payment) => sum + (Number(payment.amountCents) || 0), 0)
        };
      };

      const userReq = users.get(userId);
      userReq.onsuccess = () => { loaded.user = userReq.result; ready(); };
      userReq.onerror = () => fail(userReq.error);
      const txnReq = txns.index("userId").getAll(userId);
      txnReq.onsuccess = () => { loaded.txns = txnReq.result || []; ready(); };
      txnReq.onerror = () => fail(txnReq.error);
      const paymentReq = payments.index("userId").getAll(userId);
      paymentReq.onsuccess = () => { loaded.payments = paymentReq.result || []; ready(); };
      paymentReq.onerror = () => fail(paymentReq.error);
      const productReq = products.getAll();
      productReq.onsuccess = () => { loaded.products = productReq.result || []; ready(); };
      productReq.onerror = () => fail(productReq.error);

      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(specificError || tx.error);
      tx.onabort = () => reject(specificError || tx.error || new Error("Testnutzer-Reset abgebrochen."));
    });
  },
  async resetDatabase() {
    if (activeDb) activeDb.close();
    activeDb = null;
    dbPromise = null;
    return new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error || new Error("Werkseinstellungen konnten nicht wiederhergestellt werden."));
      req.onblocked = () => reject(new Error("Bitte andere geöffnete Fenster dieser App schließen und erneut versuchen."));
    });
  },
  async setSetting(key, value) {
    return DB.put("settings", { key, value });
  },
  async getSetting(key, fallback=null) {
    const x = await DB.get("settings", key);
    return x ? x.value : fallback;
  }
};

// Seed default data on first run
async function ensureSeed() {
  const seeded = await DB.getSetting("seeded", false);
  if (seeded) return;

  // Admin password (default): 999999
  await DB.setSetting("adminPassword", "999999");

  // Timeouts (ms)
  await DB.setSetting("userTimeoutMs", 20000);
  await DB.setSetting("adminTimeoutMs", 60000);
  await DB.setSetting("idleInputResetMs", 15000);
  await DB.setSetting("theme", "light");
  await DB.setSetting("soundEnabled", true);
  await DB.setSetting("appName", "KassenWart");
  await DB.setSetting("toastSuccessMs", 3000);

  await DB.setSetting("seeded", true);
}
