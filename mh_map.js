// =========================
// Firebase 初期化（compat）
// =========================
const firebaseConfig = {
  apiKey: "AIzaSyCi7BqLPC7hmVlPCqyFPSDYhaHjscqW_h0",
  authDomain: "mhmap-app.firebaseapp.com",
  projectId: "mhmap-app",
  storageBucket: "mhmap-app.firebasestorage.app",
  messagingSenderId: "253694025628",
  appId: "1:253694025628:web:627587ef135bacf80ff259",
};
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// =========================
// グローバル
// =========================
let _initialized = false;
let _map = null;
let _markers = [];
let _mhData = [];

let _currentMHName = null;
let _currentCableKey = null;

let _cylinderMode = false;

let _cylinderSet = new Set();
let _cylinderFetchedAt = 0;

const _detailCache = new Map(); // key -> Promise

Object.defineProperty(window, "_leafletMap", {
  get: () => _map,
  configurable: false,
});

// =========================
// ユーティリティ
// =========================
function getEl(id) { return document.getElementById(id); }

function normalizeText(s) {
  return (s ?? "").toString().trim().toLowerCase();
}

function escapeForAttr(text) {
  return String(text).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function setHint(text) {
  const el = getEl("hint");
  if (el) el.textContent = text;
}

// ★複合キー（ケーブル単位）
function makeCableKeyFromParts(station, cable, mhName) {
  const s = (station || "").toString().trim();
  const c = (cable || "").toString().trim();
  const n = (mhName || "").toString().trim();
  return `${s}__${c}__${n}`;
}
function makeCableKey(row) {
  return makeCableKeyFromParts(row["収容局"], row["ケーブル名"], row["備考"]);
}
function parseCableKey(key) {
  const parts = (key || "").split("__");
  return {
    station: parts[0] || "",
    cable: parts[1] || "",
    name: parts.slice(2).join("__") || "",
  };
}

// =========================
// ★ピン色の優先順位（重要）
// オレンジ（故障） ＞ 赤（ボンベ） ＞ 青
// =========================
function iconUrl(hasFailure, hasCylinder) {
  if (hasFailure) return "https://maps.google.com/mapfiles/ms/icons/orange-dot.png";
  if (hasCylinder) return "https://maps.google.com/mapfiles/ms/icons/red-dot.png";
  return "https://maps.google.com/mapfiles/ms/icons/blue-dot.png";
}

// =========================
// 一覧パネル制御
// =========================
function updateCylinderToggleLabel() {
  const btn = getEl("cylinderClose");
  if (!btn) return;

  const panel = getEl("cylinderPanel");
  const isVisible = panel && panel.style.display === "block";
  const isMin = document.body.classList.contains("cylinder-min");

  if (!isVisible) {
    btn.textContent = "開く";
    return;
  }
  btn.textContent = isMin ? "開く" : "閉じる";
}

function openCylinderPanel({ minimized = false } = {}) {
  const panel = getEl("cylinderPanel");
  if (!panel) return;

  panel.style.display = "block";
  document.body.classList.add("cylinder-open");

  if (minimized) document.body.classList.add("cylinder-min");
  else document.body.classList.remove("cylinder-min");

  updateCylinderToggleLabel();
  requestAnimationFrame(() => { try { _map.invalidateSize(); } catch (_) {} });
}

function toggleCylinderMinimize() {
  document.body.classList.toggle("cylinder-min");
  updateCylinderToggleLabel();
  requestAnimationFrame(() => { try { _map.invalidateSize(); } catch (_) {} });
}

function resetCylinderUi() {
  const panel = getEl("cylinderPanel");
  if (panel) panel.style.display = "none";
  document.body.classList.remove("cylinder-open");
  document.body.classList.remove("cylinder-min");
  updateCylinderToggleLabel();
  requestAnimationFrame(() => { try { _map.invalidateSize(); } catch (_) {} });
}

// =========================
// Firestore 読み込み（新キーのみ）
// =========================
async function getDetail(newKey) {
  if (newKey && _detailCache.has(newKey)) return _detailCache.get(newKey);

  const p = (async () => {
    if (!newKey) return {};
    try {
      const doc = await db.collection("mhDetails").doc(newKey).get();
      if (doc.exists) return doc.data() || {};
    } catch (e) {
      console.warn("doc取得失敗:", e);
    }
    return {};
  })();

  if (newKey) _detailCache.set(newKey, p);
  return p;
}

function clearDetailCache() {
  _detailCache.clear();
}

// =========================
// ボンベ設置Set（新キーだけ）
// =========================
async function fetchCylinderSet({ force = false } = {}) {
  const TTL = 60 * 1000;
  const now = Date.now();
  if (!force && (now - _cylinderFetchedAt) < TTL) return _cylinderSet;

  const set = new Set();
  try {
    const snap = await db.collection("mhDetails")
      .where("cylinderInstalled", "==", true)
      .get();

    snap.forEach(doc => {
      const id = doc.id || "";
      if (id.includes("__")) set.add(id);
    });
  } catch (e) {
    console.warn("ボンベ設置一覧取得失敗:", e);
  }

  _cylinderSet = set;
  _cylinderFetchedAt = now;
  return _cylinderSet;
}

// =========================
// ポップアップHTML
// =========================
function buildPopupHtml(row, lat, lng, mhName) {
  const newKey = makeCableKey(row);
  return `
    <div style="line-height:1.4">
      <div style="font-weight:bold; font-size:1.1em;">${escapeHtml(mhName || "(名称未設定)")}</div>
      <div style="font-size:1.0em;">${escapeHtml(row["収容局"] || "")}</div>
      <div>${escapeHtml(row["ケーブル名"] || "")}</div>
      <a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank">地図アプリで開く</a><br>
      <a href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}" target="_blank">ストリートビューで開く</a><br><br>
      <button type="button" onclick="openModal('${escapeForAttr(mhName)}','${escapeForAttr(newKey)}')">詳細</button>
    </div>
  `;
}

// =========================
// 初期化
// =========================
window.initApp = function initApp() {
  if (_initialized) return;
  _initialized = true;

  // モーダル
  const modal = getEl("mhModal");
  getEl("closeModal").onclick = () => modal.style.display = "none";
  window.addEventListener("click", (e) => {
    if (e.target === modal) modal.style.display = "none";
  });

  // 地図
  _map = L.map("map").setView([37.9, 139.06], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors",
    maxZoom: 20,
  }).addTo(_map);

  // ボタン類
  getEl("pressureAdd").addEventListener("click", addPressure);
  getEl("failureAdd").addEventListener("click", addFailure);
  getEl("saveBtn").addEventListener("click", saveMHDetail);

  getEl("cylinderBtn").addEventListener("click", async () => {
    _cylinderMode = true;
    await fetchCylinderSet({ force: true });
    renderCylinderList();
    updateMap();
    openCylinderPanel({ minimized: true });
  });

  getEl("cylinderClose").addEventListener("click", () => {
    const panel = getEl("cylinderPanel");
    const isVisible = panel && panel.style.display === "block";
    if (!isVisible) openCylinderPanel({ minimized: true });
    else toggleCylinderMinimize();
  });

  getEl("clearBtn").addEventListener("click", () => {
    getEl("stationFilter").value = "";
    getEl("cableFilter").innerHTML = `<option value="">収容局を選択</option>`;
    getEl("cableFilter").disabled = true;

    getEl("nameFilter").value = "";
    getEl("nameFilter").disabled = true;

    _cylinderMode = false;
    resetCylinderUi();

    clearMarkers();
    setHint("収容局を選択するとピンを表示します");
  });

  // フィルタ変更（ボンベ解除）
  getEl("stationFilter").addEventListener("change", () => {
    if (_cylinderMode) { _cylinderMode = false; resetCylinderUi(); }

    const station = getEl("stationFilter").value;
    if (!station) {
      getEl("cableFilter").innerHTML = `<option value="">収容局を選択</option>`;
      getEl("cableFilter").disabled = true;

      getEl("nameFilter").value = "";
      getEl("nameFilter").disabled = true;

      clearMarkers();
      setHint("収容局を選択するとピンを表示します");
      return;
    }

    getEl("cableFilter").disabled = false;
    getEl("nameFilter").disabled = false;

    updateCableFilter();
    updateNameOptions();
    updateMap();
  });

  getEl("cableFilter").addEventListener("change", () => {
    if (_cylinderMode) { _cylinderMode = false; resetCylinderUi(); }
    if (!getEl("stationFilter").value) return;
    updateNameOptions();
    updateMap();
  });

  getEl("nameFilter").addEventListener("input", () => {
    if (_cylinderMode) { _cylinderMode = false; resetCylinderUi(); }
    if (!getEl("stationFilter").value) return;
    updateMap();
  });

  // CSV
  Papa.parse("./mh_data.csv", {
    download: true,
    header: true,
    skipEmptyLines: true,
    complete: (results) => {
      _mhData = results.data || [];
      populateStationFilter();
      setHint("収容局を選択するとピンを表示します");
      updateCylinderToggleLabel();
      requestAnimationFrame(() => { try { _map.invalidateSize(); } catch (_) {} });
    },
    error: (err) => {
      console.error("CSV 読み込み失敗:", err);
      alert("データの読み込みに失敗しました。");
    },
  });
};

// =========================
// フィルタ構築
// =========================
function populateStationFilter() {
  const stationSelect = getEl("stationFilter");
  const stationSet = new Set();

  _mhData.forEach((item) => {
    if (item["収容局"]) stationSet.add(item["収容局"]);
  });

  stationSelect.innerHTML =
    `<option value="">選択してください</option>` +
    [...stationSet]
      .sort((a, b) => a.localeCompare(b, "ja"))
      .map((s) => `<option>${s}</option>`)
      .join("");
}

function updateCableFilter() {
  const selectedStation = getEl("stationFilter").value;
  const cableSelect = getEl("cableFilter");
  const cableSet = new Set();

  _mhData.forEach((row) => {
    if (row["収容局"] === selectedStation) {
      if (row["ケーブル名"]) cableSet.add(row["ケーブル名"]);
    }
  });

  cableSelect.innerHTML =
    `<option value="">すべて</option>` +
    [...cableSet]
      .sort((a, b) => a.localeCompare(b, "ja"))
      .map((c) => `<option>${c}</option>`)
      .join("");
}

function updateNameOptions() {
  const selectedStation = getEl("stationFilter").value;
  const selectedCable = getEl("cableFilter").value;
  const dl = getEl("nameOptions");
  if (!dl) return;

  const nameSet = new Set();
  _mhData.forEach((row) => {
    if (
      row["収容局"] === selectedStation &&
      (!selectedCable || row["ケーブル名"] === selectedCable)
    ) {
      const name = (row["備考"] || "").trim();
      if (name) nameSet.add(name);
    }
  });

  dl.innerHTML = [...nameSet]
    .sort((a, b) => a.localeCompare(b, "ja"))
    .map((n) => `<option value="${escapeForAttr(n)}"></option>`)
    .join("");
}

// =========================
// 地図描画
// =========================
function clearMarkers() {
  _markers.forEach((m) => _map.removeLayer(m));
  _markers = [];
}

function getUniqueCylinderTargetsFromCsv() {
  const map = new Map();
  _mhData.forEach((row) => {
    const mhName = (row["備考"] || "").trim();
    if (!mhName) return;

    const lat = parseFloat(row["緯度"]);
    const lng = parseFloat(row["経度"]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    const key = makeCableKey(row);
    if (!_cylinderSet.has(key)) return;

    if (!map.has(key)) map.set(key, { row, mhName, lat, lng, key });
  });
  return [...map.values()];
}

function updateMap() {
  // ===== ボンベモード：ボンベのある設備だけ表示（ただし故障があればオレンジ優先）=====
  if (_cylinderMode) {
    clearMarkers();

    const targets = getUniqueCylinderTargetsFromCsv();
    setHint(`表示件数：${targets.length}（ボンベ設置のみ）`);

    targets.forEach(({ row, mhName, lat, lng, key }) => {
      const popupHtml = buildPopupHtml(row, lat, lng, mhName);

      // ★ボンベモードでも故障色を判定するためFirestoreを見る
      getDetail(key).then((data) => {
        const hasFailure = data.failures && Object.keys(data.failures).length > 0;
        const hasCylinder = true;

        const marker = L.marker([lat, lng], {
          icon: L.icon({
            iconUrl: iconUrl(hasFailure, hasCylinder), // ★オレンジ優先
            iconSize: [32, 32],
            iconAnchor: [16, 32],
            popupAnchor: [0, -32],
          }),
        }).addTo(_map).bindPopup(popupHtml);

        marker.__cableKey = key;
        _markers.push(marker);
      }).catch(() => {
        // Firestore取れない場合は赤
        const marker = L.marker([lat, lng], {
          icon: L.icon({
            iconUrl: iconUrl(false, true),
            iconSize: [32, 32],
            iconAnchor: [16, 32],
            popupAnchor: [0, -32],
          }),
        }).addTo(_map).bindPopup(popupHtml);

        marker.__cableKey = key;
        _markers.push(marker);
      });
    });

    return;
  }

  // ===== 通常モード =====
  const selectedStation = getEl("stationFilter").value;
  if (!selectedStation) {
    clearMarkers();
    return;
  }

  clearMarkers();

  const selectedCable = getEl("cableFilter").value;
  const nameQuery = normalizeText(getEl("nameFilter")?.value);

  const filtered = _mhData.filter((row) => {
    if (row["収容局"] !== selectedStation) return false;

    const okCable = !selectedCable || row["ケーブル名"] === selectedCable;
    const name = normalizeText(row["備考"]);
    const okName = !nameQuery || name.includes(nameQuery);
    return okCable && okName;
  });

  setHint(`表示件数：${filtered.length}`);

  filtered.forEach((row) => {
    const lat = parseFloat(row["緯度"]);
    const lng = parseFloat(row["経度"]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    const mhName = (row["備考"] || "").trim();
    const popupHtml = buildPopupHtml(row, lat, lng, mhName);

    const key = makeCableKey(row);

    // Firestoreが死んでもピンは出す
    getDetail(key).then((data) => {
      const hasFailure = data.failures && Object.keys(data.failures).length > 0;
      const hasCylinder = data.cylinderInstalled === true;

      const marker = L.marker([lat, lng], {
        icon: L.icon({
          iconUrl: iconUrl(hasFailure, hasCylinder), // ★オレンジ優先
          iconSize: [32, 32],
          iconAnchor: [16, 32],
          popupAnchor: [0, -32],
        }),
      }).addTo(_map).bindPopup(popupHtml);

      marker.__cableKey = key;
      _markers.push(marker);
    }).catch(() => {
      const marker = L.marker([lat, lng], {
        icon: L.icon({
          iconUrl: iconUrl(false, false),
          iconSize: [32, 32],
          iconAnchor: [16, 32],
          popupAnchor: [0, -32],
        }),
      }).addTo(_map).bindPopup(popupHtml);

      marker.__cableKey = key;
      _markers.push(marker);
    });
  });
}

// =========================
// ボンベ一覧
// =========================
function renderCylinderList() {
  const listEl = getEl("cylinderList");
  const sumEl = getEl("cylinderSummary");
  if (!listEl || !sumEl) return;

  listEl.innerHTML = "";
  const targets = getUniqueCylinderTargetsFromCsv();

  sumEl.textContent = `ボンベ設置一覧：${targets.length}件（クリックで移動）`;

  if (targets.length === 0) {
    listEl.innerHTML = `<div style="color:#666; font-size:0.95rem;">該当なし</div>`;
    return;
  }

  targets.forEach(({ row, mhName, lat, lng, key }) => {
    const btn = document.createElement("button");
    const station = (row["収容局"] || "").toString();
    const cable = (row["ケーブル名"] || "").toString();
    btn.type = "button";
    btn.textContent = `${mhName}（${station} / ${cable}）`;

    btn.onclick = () => {
      _map.setView([lat, lng], Math.max(_map.getZoom(), 16));
      const m = _markers.find(x => x.__cableKey === key);
      if (m) m.openPopup();
    };
    listEl.appendChild(btn);
  });
}

// =========================
// モーダル
// =========================
window.openModal = function openModal(mhName, newKey) {
  _currentMHName = mhName || null;
  _currentCableKey = newKey || null;

  getEl("modalTitle").textContent = `${mhName || "(名称未設定)"}　詳細情報`;

  const meta = getEl("modalMeta");
  if (meta) {
    const p = parseCableKey(newKey || "");
    meta.textContent = `収容局：${p.station || "-"} ／ ケーブル：${p.cable || "-"} ／ 設備：${p.name || (mhName || "-")}`;
  }

  // 初期化
  getEl("mhSize").value = "";
  getEl("closureType").value = "";
  getEl("pressureList").innerHTML = "";
  getEl("failureList").innerHTML = "";
  getEl("pressureDate").value = "";
  getEl("pressureValue").value = "";
  getEl("failureDate").value = "";
  getEl("failureStatus").value = "";
  getEl("failureComment").value = "";

  getEl("cylinderYes").checked = false;
  getEl("cylinderNo").checked = true;

  const modal = getEl("mhModal");

  if (!mhName || !newKey) {
    modal.style.display = "block";
    return;
  }

  getDetail(newKey).then((data) => {
    getEl("mhSize").value = data.size || "";
    getEl("closureType").value = data.closure || "";

    const cyl = data.cylinderInstalled === true;
    getEl("cylinderYes").checked = cyl;
    getEl("cylinderNo").checked = !cyl;

    if (data.pressure) {
      Object.keys(data.pressure).sort().forEach(date => {
        appendPressureItem(date, data.pressure[date]);
      });
    }
    if (data.failures) {
      Object.keys(data.failures).sort().forEach(date => {
        const f = data.failures[date] || {};
        appendFailureItem(date, f.status || "", f.comment || "");
      });
    }

    modal.style.display = "block";
  }).catch(() => {
    modal.style.display = "block";
  });
};

function addPressure() {
  const date = getEl("pressureDate").value;
  const val = getEl("pressureValue").value;
  if (date && val !== "") appendPressureItem(date, val);
}

function appendPressureItem(date, val) {
  const list = getEl("pressureList");
  const div = document.createElement("div");
  div.dataset.date = date;
  div.dataset.value = val;
  div.innerHTML = `
    ${escapeHtml(date)}: ${escapeHtml(val)}
    <button class="delete-pressure" data-date="${escapeForAttr(date)}" type="button">削除</button>
  `;
  div.querySelector(".delete-pressure").onclick = () => {
    if (confirm("この項目を削除しますか？")) div.remove();
  };
  list.appendChild(div);
}

function addFailure() {
  const date = getEl("failureDate").value;
  const status = getEl("failureStatus").value;
  const comment = getEl("failureComment").value;
  if (date && status) appendFailureItem(date, status, comment);
}

function appendFailureItem(date, status, comment) {
  const list = getEl("failureList");
  const div = document.createElement("div");
  div.dataset.date = date;
  div.dataset.status = status;
  div.dataset.comment = comment;
  div.innerHTML = `
    ${escapeHtml(date)}: [${escapeHtml(status)}] ${comment ? escapeHtml(comment) : ""}
    <button class="delete-failure" data-date="${escapeForAttr(date)}" type="button">削除</button>
  `;
  div.querySelector(".delete-failure").onclick = () => {
    if (confirm("この項目を削除しますか？")) div.remove();
  };
  list.appendChild(div);
}

// =========================
// 保存
// =========================
async function saveMHDetail() {
  if (!_currentCableKey || !_currentMHName) {
    alert("保存キーが不足しています。ポップアップの『詳細』から開いてください。");
    return;
  }

  const size = getEl("mhSize").value;
  const closure = getEl("closureType").value;
  const cylinderInstalled = !!getEl("cylinderYes").checked;

  const pressure = {};
  [...getEl("pressureList").children].forEach(item => {
    const date = item.dataset.date;
    const val = item.dataset.value;
    if (date && val !== undefined) pressure[date] = val;
  });

  const failures = {};
  [...getEl("failureList").children].forEach(item => {
    const date = item.dataset.date;
    const status = item.dataset.status;
    const comment = item.dataset.comment;
    if (date && status != null) failures[date] = { status, comment };
  });

  try {
    await db.collection("mhDetails").doc(_currentCableKey).set({
      size, closure, pressure, failures,
      cylinderInstalled,
    });

    alert("保存しました");
    getEl("mhModal").style.display = "none";

    clearDetailCache();
    await fetchCylinderSet({ force: true });

    if (_cylinderMode) {
      renderCylinderList();
      openCylinderPanel({ minimized: true });
    }

    updateMap();
  } catch (err) {
    console.error("保存失敗:", err);
    alert("保存に失敗しました");
  }
}
