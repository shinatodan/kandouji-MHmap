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
// グローバル（安全に1回だけ初期化）
// =========================
let _initialized = false;
let _map = null;
let _markers = [];
let _mhData = [];
let _currentMHId = null;

// ★互換：新キー（収容局__ケーブル__備考）を保持
let _currentCableKey = null;

// ボンベモード（収容局に関係なくボンベ設置だけ表示）
let _cylinderMode = false;

// ボンベ一覧（Firestore whereで集めた doc.id のSet）
let _cylinderSet = new Set();
let _cylinderFetchedAt = 0;

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

// ★新：複合キー（ケーブル単位）
function makeCableKeyFromParts(station, cable, mhName) {
  return `${(station || "").toString().trim()}__${(cable || "").toString().trim()}__${(mhName || "").toString().trim()}`;
}
function makeCableKey(row) {
  return makeCableKeyFromParts(row["収容局"], row["ケーブル名"], row["備考"]);
}

// 既存のiconUrl互換を維持しつつ拡張
function iconUrl(hasFailure, hasCylinder = false) {
  if (hasCylinder) return "https://maps.google.com/mapfiles/ms/icons/red-dot.png";
  return hasFailure
    ? "https://maps.google.com/mapfiles/ms/icons/orange-dot.png"
    : "https://maps.google.com/mapfiles/ms/icons/blue-dot.png";
}

// ===== 一覧パネル（閉じる/開く 表示名切替） =====
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

function openCylinderPanel() {
  const panel = getEl("cylinderPanel");
  if (!panel) return;

  panel.style.display = "block";
  document.body.classList.add("cylinder-open");
  document.body.classList.remove("cylinder-min");
  updateCylinderToggleLabel();
  setTimeout(() => _map.invalidateSize(), 0);
}

function toggleCylinderMinimize() {
  document.body.classList.toggle("cylinder-min");
  updateCylinderToggleLabel();
  setTimeout(() => _map.invalidateSize(), 0);
}

function resetCylinderUi() {
  const panel = getEl("cylinderPanel");
  if (panel) panel.style.display = "none";
  document.body.classList.remove("cylinder-open");
  document.body.classList.remove("cylinder-min");
  updateCylinderToggleLabel();
  setTimeout(() => _map.invalidateSize(), 0);
}

// =========================
// Firestore 互換読み込み（新→旧）
// =========================
async function getDetailDocWithFallback(mhName, cableKey) {
  // 返り値：{ data, source: "new"|"old"|"none" }
  // 新doc（複合キー）優先
  if (cableKey) {
    try {
      const newDoc = await db.collection("mhDetails").doc(cableKey).get();
      if (newDoc.exists) return { data: newDoc.data() || {}, source: "new" };
    } catch (e) {
      console.warn("新doc取得失敗:", e);
    }
  }
  // 旧doc（備考）
  if (mhName) {
    try {
      const oldDoc = await db.collection("mhDetails").doc(mhName).get();
      if (oldDoc.exists) return { data: oldDoc.data() || {}, source: "old" };
    } catch (e) {
      console.warn("旧doc取得失敗:", e);
    }
  }
  return { data: {}, source: "none" };
}

// =========================
// ボンベ設置Setをwhereで取得（新doc=複合キー）
// =========================
async function fetchCylinderSet({ force = false } = {}) {
  const TTL = 60 * 1000;
  const now = Date.now();
  if (!force && (now - _cylinderFetchedAt) < TTL && _cylinderSet.size > 0) {
    return _cylinderSet;
  }

  const set = new Set();
  try {
    const snap = await db.collection("mhDetails")
      .where("cylinderInstalled", "==", true)
      .get();
    snap.forEach(doc => {
      if (doc.id) set.add(doc.id); // ★doc.id = 複合キー（または旧備考キーも混在し得る）
    });
  } catch (e) {
    console.warn("ボンベ設置一覧取得失敗:", e);
  }

  _cylinderSet = set;
  _cylinderFetchedAt = now;
  return _cylinderSet;
}

// =========================
// ポップアップHTML（詳細ボタンに複合キーも渡す）
// =========================
function buildPopupHtml(row, lat, lng, mhName) {
  const cableKey = makeCableKey(row);
  return `
    <div style="line-height:1.4">
      <div style="font-weight:bold; font-size:1.1em;">${escapeHtml(mhName || "(名称未設定)")}</div>
      <div style="font-size:1.0em;">${escapeHtml(row["収容局"] || "")}</div>
      <div>
        ${
          row["pdfファイル名"]
            ? `<a href="MHpdf/${encodeURIComponent(row["pdfファイル名"])}" target="_blank">${escapeHtml(row["ケーブル名"] || "詳細PDF")}</a>`
            : escapeHtml(row["ケーブル名"] || "")
        }
      </div>
      <a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank">地図アプリで開く</a><br>
      <a href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}" target="_blank">ストリートビューで開く</a><br><br>
      <button onclick="openModal('${escapeForAttr(mhName)}','${escapeForAttr(cableKey)}')">詳細</button>
    </div>
  `;
}

// =========================
// 初期化本体
// =========================
window.initApp = function initApp() {
  if (_initialized) return;
  _initialized = true;

  // モーダル操作
  const modal = getEl("mhModal");
  const closeModalBtn = getEl("closeModal");
  closeModalBtn.onclick = () => modal.style.display = "none";
  window.addEventListener("click", (e) => {
    if (e.target === modal) modal.style.display = "none";
  });

  // 地図生成（ピンは初期表示しない）
  _map = L.map("map").setView([37.9, 139.06], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors",
    maxZoom: 20,
  }).addTo(_map);

  // イベント（追加／保存）
  getEl("pressureAdd").addEventListener("click", addPressure);
  getEl("failureAdd").addEventListener("click", addFailure);
  getEl("saveBtn").addEventListener("click", saveMHDetail);

  // ボンベ設置個所（収容局未選択でもOK）
  getEl("cylinderBtn").addEventListener("click", async () => {
    _cylinderMode = true;
    openCylinderPanel();
    await fetchCylinderSet({ force: true });
    renderCylinderList();
    updateMap();
  });

  // 「閉じる/開く」＝最小化トグル
  getEl("cylinderClose").addEventListener("click", () => {
    const panel = getEl("cylinderPanel");
    const isVisible = panel && panel.style.display === "block";
    if (!isVisible) {
      openCylinderPanel();
      renderCylinderList();
      return;
    }
    toggleCylinderMinimize();
  });

  // クリア（既存＋ボンベ解除）
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

  // フィルタ変更（既存のまま。ボンベモードは解除）
  getEl("stationFilter").addEventListener("change", () => {
    if (_cylinderMode) {
      _cylinderMode = false;
      resetCylinderUi();
    }

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
    if (_cylinderMode) {
      _cylinderMode = false;
      resetCylinderUi();
    }

    const station = getEl("stationFilter").value;
    if (!station) return;
    updateNameOptions();
    updateMap();
  });

  getEl("nameFilter").addEventListener("input", () => {
    if (_cylinderMode) {
      _cylinderMode = false;
      resetCylinderUi();
    }

    const station = getEl("stationFilter").value;
    if (!station) return;
    updateMap();
  });

  // CSV読み込み
  Papa.parse("./mh_data.csv", {
    download: true,
    header: true,
    skipEmptyLines: true,
    complete: (results) => {
      _mhData = results.data || [];
      console.log("CSV loaded rows:", _mhData.length);

      populateStationFilter();
      setHint("収容局を選択するとピンを表示します");
      updateCylinderToggleLabel();
      // 初期はピン描画しない
    },
    error: (err) => {
      console.error("CSV 読み込み失敗:", err);
      alert("データの読み込みに失敗しました。");
    },
  });
};

// =========================
// フィルタ構築（既存）
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

function updateMap() {
  // ===== ボンベモード（収容局に関係なくボンベ設置のみ）=====
  if (_cylinderMode) {
    clearMarkers();

    if (!_cylinderSet || _cylinderSet.size === 0) {
      setHint("表示件数：0（ボンベ設置のみ）");
      return;
    }

    let count = 0;

    _mhData.forEach((row) => {
      const lat = parseFloat(row["緯度"]);
      const lng = parseFloat(row["経度"]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

      const mhName = (row["備考"] || "").trim();
      if (!mhName) return;

      const key = makeCableKey(row);
      // ★互換：旧doc（備考）で cylinderInstalled を付けていた過去も拾う
      const isCylinder = _cylinderSet.has(key) || _cylinderSet.has(mhName);
      if (!isCylinder) return;

      const popupHtml = buildPopupHtml(row, lat, lng, mhName);

      const marker = L.marker([lat, lng], {
        icon: L.icon({
          iconUrl: iconUrl(false, true),
          iconSize: [32, 32],
          iconAnchor: [16, 32],
          popupAnchor: [0, -32],
        }),
      }).addTo(_map).bindPopup(popupHtml);

      marker.__cableKey = key;
      marker.__mhName = mhName;
      _markers.push(marker);
      count++;
    });

    setHint(`表示件数：${count}（ボンベ設置のみ）`);
    return;
  }

  // ===== 通常モード（既存：収容局未選択なら描画しない）=====
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

    // mhName が空のときは Firestore の参照をスキップして青固定
    if (!mhName) {
      const marker = L.marker([lat, lng], {
        icon: L.icon({
          iconUrl: iconUrl(false, false),
          iconSize: [32, 32],
          iconAnchor: [16, 32],
          popupAnchor: [0, -32],
        }),
      }).addTo(_map).bindPopup(popupHtml);

      _markers.push(marker);
      return;
    }

    const cableKey = makeCableKey(row);

    // ★互換：新doc→旧docで取得
    getDetailDocWithFallback(mhName, cableKey).then(({ data, source }) => {
      const hasFailure = data.failures && Object.keys(data.failures).length > 0;

      // ボンベは「新doc」に入る想定。ただし旧docしか無い過去データも拾う
      const hasCylinder =
        data.cylinderInstalled === true ||
        (_cylinderSet && (_cylinderSet.has(cableKey) || _cylinderSet.has(mhName)));

      const marker = L.marker([lat, lng], {
        icon: L.icon({
          iconUrl: iconUrl(hasFailure, hasCylinder),
          iconSize: [32, 32],
          iconAnchor: [16, 32],
          popupAnchor: [0, -32],
        }),
      }).addTo(_map).bindPopup(popupHtml);

      marker.__mhName = mhName;
      marker.__cableKey = cableKey;
      marker.__source = source;
      _markers.push(marker);
    }).catch((err) => {
      console.warn("詳細取得失敗:", err);

      const marker = L.marker([lat, lng], {
        icon: L.icon({
          iconUrl: iconUrl(false, false),
          iconSize: [32, 32],
          iconAnchor: [16, 32],
          popupAnchor: [0, -32],
        }),
      }).addTo(_map).bindPopup(popupHtml);

      marker.__mhName = mhName;
      marker.__cableKey = cableKey;
      _markers.push(marker);
    });
  });
}

// =========================
// ボンベ一覧（CSV順、クリックで移動しても全件ピン表示のまま）
// =========================
function renderCylinderList() {
  const listEl = getEl("cylinderList");
  const sumEl = getEl("cylinderSummary");
  if (!listEl || !sumEl) return;

  listEl.innerHTML = "";

  if (!_cylinderSet || _cylinderSet.size === 0) {
    sumEl.textContent = "ボンベ設置一覧：0件";
    listEl.innerHTML = `<div style="color:#666; font-size:0.95rem;">該当なし</div>`;
    return;
  }

  const rows = [];
  _mhData.forEach((row) => {
    const mhName = (row["備考"] || "").trim();
    if (!mhName) return;

    const lat = parseFloat(row["緯度"]);
    const lng = parseFloat(row["経度"]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    const key = makeCableKey(row);
    // ★互換：旧doc（備考）でのフラグも拾う
    const isCylinder = _cylinderSet.has(key) || _cylinderSet.has(mhName);
    if (!isCylinder) return;

    rows.push({ row, mhName, lat, lng, key });
  });

  sumEl.textContent = `ボンベ設置一覧：${rows.length}件（クリックで移動）`;

  if (rows.length === 0) {
    listEl.innerHTML = `<div style="color:#666; font-size:0.95rem;">（CSVに座標がある設置個所がありません）</div>`;
    return;
  }

  rows.forEach(({ row, mhName, lat, lng, key }) => {
    const btn = document.createElement("button");
    const station = (row["収容局"] || "").toString();
    const cable = (row["ケーブル名"] || "").toString();
    btn.type = "button";
    btn.textContent = `${mhName}（${station} / ${cable}）`;

    // ★移動のみ（再描画しない）→ ピンは全件表示のまま
    btn.onclick = () => {
      _map.setView([lat, lng], Math.max(_map.getZoom(), 16));
      const m = _markers.find(x => x.__cableKey === key);
      if (m) m.openPopup();
    };

    listEl.appendChild(btn);
  });
}

// =========================
// モーダルと保存（互換：新→旧で読んで、新に保存）
// =========================
window.openModal = function openModal(mhName, cableKey) {
  _currentMHId = mhName || null;
  _currentCableKey = cableKey || null;

  getEl("modalTitle").textContent = `${mhName || "(名称未設定)"}　詳細情報`;

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

  // ボンベラジオ初期化（デフォは「なし」）
  getEl("cylinderYes").checked = false;
  getEl("cylinderNo").checked = true;

  const modal = getEl("mhModal");

  if (!mhName) {
    modal.style.display = "block";
    return;
  }

  getDetailDocWithFallback(mhName, cableKey).then(({ data }) => {
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
  }).catch(err => {
    console.error("詳細取得失敗:", err);
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

function saveMHDetail() {
  // ★互換：新キーが無いとケーブル単位で保存できない
  if (!_currentMHId || !_currentCableKey) {
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

  // ★保存は新doc（複合キー）に集約
  db.collection("mhDetails").doc(_currentCableKey).set({
    size, closure, pressure, failures,
    cylinderInstalled,
  }).then(async () => {
    alert("保存しました");
    getEl("mhModal").style.display = "none";

    // ボンベ一覧・赤ピンを即更新
    await fetchCylinderSet({ force: true });
    if (_cylinderMode) {
      renderCylinderList();
      updateCylinderToggleLabel();
    }

    updateMap();
  }).catch(err => {
    console.error("保存失敗:", err);
    alert("保存に失敗しました");
  });
}
