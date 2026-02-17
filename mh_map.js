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
let _currentMHId = null;

// ボンベモード：ONのときは「全収容局・全ケーブル」から抽出して表示
let _showCylinderOnly = false;

// ボンベ設置フラグを一括取得した結果（キャッシュ）
let _cylinderSet = new Set();
let _cylinderSetFetchedAt = 0; // ms

Object.defineProperty(window, "_leafletMap", {
  get: () => _map,
  configurable: false,
});

// =========================
// ユーティリティ
// =========================
function getEl(id) { return document.getElementById(id); }

function iconUrl({ hasFailure, hasCylinder }) {
  if (hasCylinder) return "https://maps.google.com/mapfiles/ms/icons/red-dot.png";
  if (hasFailure) return "https://maps.google.com/mapfiles/ms/icons/orange-dot.png";
  return "https://maps.google.com/mapfiles/ms/icons/blue-dot.png";
}

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

function ensureRadioDefault() {
  const yes = getEl("cylinderYes");
  const no = getEl("cylinderNo");
  if (yes && no && !yes.checked && !no.checked) no.checked = true;
}

// =========================
// 重要：ピンソート（従来機能を維持）
// ここをあなたの「今までの並び」に合わせて調整できる
// デフォ：ケーブル名 → 設備名(備考) → 緯度 → 経度
// =========================
function sortRowsForPins(rows) {
  return rows.sort((a, b) => {
    const ac = (a["ケーブル名"] || "").toString();
    const bc = (b["ケーブル名"] || "").toString();
    const c1 = ac.localeCompare(bc, "ja");
    if (c1 !== 0) return c1;

    const an = (a["備考"] || "").toString();
    const bn = (b["備考"] || "").toString();
    const c2 = an.localeCompare(bn, "ja");
    if (c2 !== 0) return c2;

    const alat = parseFloat(a["緯度"]);
    const blat = parseFloat(b["緯度"]);
    if (Number.isFinite(alat) && Number.isFinite(blat) && alat !== blat) return alat - blat;

    const alng = parseFloat(a["経度"]);
    const blng = parseFloat(b["経度"]);
    if (Number.isFinite(alng) && Number.isFinite(blng) && alng !== blng) return alng - blng;

    return 0;
  });
}

// =========================
// ボンベ設置Setを一括取得（whereで真だけ）
// - 収容局未選択でもOKにするための肝
// - 1件ずつgetしないので高速
// =========================
async function fetchCylinderSetIfNeeded({ force = false } = {}) {
  // キャッシュ有効期限（例：60秒）
  const TTL = 60 * 1000;
  const now = Date.now();

  if (!force && _cylinderSet.size > 0 && (now - _cylinderSetFetchedAt) < TTL) {
    return _cylinderSet;
  }

  const set = new Set();
  try {
    const snap = await db.collection("mhDetails")
      .where("cylinderInstalled", "==", true)
      .get();

    snap.forEach(doc => {
      // doc.id = mhName（今の設計）
      if (doc.id) set.add(doc.id);
    });
  } catch (e) {
    console.warn("ボンベ設置一覧の取得に失敗:", e);
  }

  _cylinderSet = set;
  _cylinderSetFetchedAt = now;
  return _cylinderSet;
}

// =========================
// 初期化
// =========================
window.initApp = function initApp() {
  if (_initialized) return;
  _initialized = true;

  // モーダル操作
  const modal = getEl("mhModal");
  getEl("closeModal").onclick = () => modal.style.display = "none";
  window.addEventListener("click", (e) => {
    if (e.target === modal) modal.style.display = "none";
  });

  // 地図生成（初期ピンなし）
  _map = L.map("map").setView([37.9, 139.06], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors",
    maxZoom: 20,
  }).addTo(_map);

  // 追加／保存
  getEl("pressureAdd").addEventListener("click", addPressure);
  getEl("failureAdd").addEventListener("click", addFailure);
  getEl("saveBtn").addEventListener("click", saveMHDetail);

  // ボンベ設置個所（収容局未選択でもOK）
  getEl("cylinderBtn").addEventListener("click", async () => {
    _showCylinderOnly = true;
    getEl("cylinderPanel").style.display = "block";

    await fetchCylinderSetIfNeeded({ force: true }); // 最新を取りたいならforce:true
    await updateMap(); // ボンベの赤ピンだけ描画
    await renderCylinderList(); // 一覧も更新
  });

  // ボンベ一覧を閉じる（通常表示に戻す）
  getEl("cylinderClose").addEventListener("click", () => {
    getEl("cylinderPanel").style.display = "none";
    _showCylinderOnly = false;
    updateMap();
  });

  // クリア
  getEl("clearBtn").addEventListener("click", () => {
    getEl("stationFilter").value = "";
    getEl("cableFilter").innerHTML = `<option value="">収容局を選択</option>`;
    getEl("cableFilter").disabled = true;

    getEl("nameFilter").value = "";
    getEl("nameFilter").disabled = true;

    _showCylinderOnly = false;
    getEl("cylinderPanel").style.display = "none";

    clearMarkers();
    setHint("収容局を選択するとピンを表示します");
  });

  // フィルタ変更イベント（通常モード）
  getEl("stationFilter").addEventListener("change", () => {
    const station = getEl("stationFilter").value;

    // ボンベモード中なら解除（ユーザー操作を優先）
    _showCylinderOnly = false;
    getEl("cylinderPanel").style.display = "none";

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
    _showCylinderOnly = false;
    getEl("cylinderPanel").style.display = "none";
    updateNameOptions();
    updateMap();
  });

  getEl("nameFilter").addEventListener("input", () => {
    _showCylinderOnly = false;
    getEl("cylinderPanel").style.display = "none";
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
      .map((s) => `<option>${escapeHtml(s)}</option>`)
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
      .map((c) => `<option>${escapeHtml(c)}</option>`)
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

// 通常：収容局選択必須で表示
// ボンベモード：収容局未選択でもボンベ設置のみ表示（全体から抽出）
async function updateMap() {
  clearMarkers();

  const selectedStation = getEl("stationFilter").value;
  const selectedCable = getEl("cableFilter").value;
  const nameQuery = normalizeText(getEl("nameFilter")?.value);

  let rows = [];

  if (_showCylinderOnly) {
    // ボンベ設置セットとCSVを突合（収容局関係なく全件対象）
    const set = await fetchCylinderSetIfNeeded();
    rows = _mhData.filter((row) => {
      const mhName = (row["備考"] || "").trim();
      if (!mhName) return false;
      if (!set.has(mhName)) return false;

      const lat = parseFloat(row["緯度"]);
      const lng = parseFloat(row["経度"]);
      return Number.isFinite(lat) && Number.isFinite(lng);
    });

    rows = sortRowsForPins(rows);

    // 描画（全部赤）
    for (const row of rows) {
      const lat = parseFloat(row["緯度"]);
      const lng = parseFloat(row["経度"]);
      const mhName = (row["備考"] || "").trim();

      const popupHtml = buildPopupHtml(row, lat, lng, mhName);

      const marker = L.marker([lat, lng], {
        icon: L.icon({
          iconUrl: iconUrl({ hasFailure: false, hasCylinder: true }),
          iconSize: [32, 32],
          iconAnchor: [16, 32],
          popupAnchor: [0, -32],
        }),
      }).addTo(_map).bindPopup(popupHtml);

      marker.__mhName = mhName;
      _markers.push(marker);
    }

    setHint(`表示件数：${rows.length}（ボンベ設置のみ）`);
    return;
  }

  // ===== 通常モード =====
  if (!selectedStation) {
    setHint("収容局を選択するとピンを表示します");
    return;
  }

  // 収容局＋ケーブル＋名称で絞り込み
  rows = _mhData.filter((row) => {
    if (row["収容局"] !== selectedStation) return false;

    const okCable = !selectedCable || row["ケーブル名"] === selectedCable;

    const name = normalizeText(row["備考"]);
    const okName = !nameQuery || name.includes(nameQuery);

    return okCable && okName;
  });

  // ★ここで従来の「並び」を維持（ソート）
  rows = sortRowsForPins(rows);

  // 通常は Firestore から故障/ボンベを反映したいけど、
  // 1件ずつGETすると重くなるので、ここでは「ボンベだけ赤」を反映したい場合は
  // 既に fetchCylinderSetIfNeeded のSetで判定する（高速）
  const cylinderSet = await fetchCylinderSetIfNeeded();

  for (const row of rows) {
    const lat = parseFloat(row["緯度"]);
    const lng = parseFloat(row["経度"]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const mhName = (row["備考"] || "").trim();
    const hasCylinder = mhName ? cylinderSet.has(mhName) : false;

    const popupHtml = buildPopupHtml(row, lat, lng, mhName);

    const marker = L.marker([lat, lng], {
      icon: L.icon({
        iconUrl: iconUrl({ hasFailure: false, hasCylinder }),
        iconSize: [32, 32],
        iconAnchor: [16, 32],
        popupAnchor: [0, -32],
      }),
    }).addTo(_map).bindPopup(popupHtml);

    marker.__mhName = mhName;
    _markers.push(marker);
  }

  setHint(`表示件数：${_markers.length}`);
}

function buildPopupHtml(row, lat, lng, mhName) {
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
      <button onclick="openModal('${escapeForAttr(mhName)}')">詳細</button>
    </div>
  `;
}

// =========================
// モーダルと保存
// =========================
window.openModal = function openModal(mhName) {
  _currentMHId = mhName;
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

  db.collection("mhDetails").doc(mhName).get().then(doc => {
    if (doc.exists) {
      const data = doc.data() || {};
      getEl("mhSize").value = data.size || "";
      getEl("closureType").value = data.closure || "";

      // ボンベ
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
    }
    ensureRadioDefault();
    modal.style.display = "block";
  }).catch(err => {
    console.error("詳細取得失敗:", err);
    ensureRadioDefault();
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
  if (!_currentMHId) {
    alert("名称未設定のため保存できません。CSVの『備考』に名称を設定してください。");
    return;
  }

  const size = getEl("mhSize").value;
  const closure = getEl("closureType").value;

  // ボンベフラグ
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

  db.collection("mhDetails").doc(_currentMHId).set({
    size, closure, pressure, failures, cylinderInstalled
  }).then(async () => {
    alert("保存しました");
    getEl("mhModal").style.display = "none";

    // ボンベSetキャッシュを最新化（赤表示・一覧の反映を即時にする）
    await fetchCylinderSetIfNeeded({ force: true });

    await updateMap();

    if (_showCylinderOnly && getEl("cylinderPanel").style.display !== "none") {
      await renderCylinderList();
    }
  }).catch(err => {
    console.error("保存失敗:", err);
    alert("保存に失敗しました");
  });
}

// =========================
// ボンベ設置一覧（全体から抽出してソート）
// =========================
async function renderCylinderList() {
  const listEl = getEl("cylinderList");
  const sumEl = getEl("cylinderSummary");
  listEl.innerHTML = "";

  const set = await fetchCylinderSetIfNeeded();

  // ボンベありのCSV行だけ抽出（収容局関係なし）
  let rows = _mhData.filter((r) => {
    const mhName = (r["備考"] || "").trim();
    if (!mhName) return false;
    if (!set.has(mhName)) return false;

    const lat = parseFloat(r["緯度"]);
    const lng = parseFloat(r["経度"]);
    return Number.isFinite(lat) && Number.isFinite(lng);
  });

  rows = sortRowsForPins(rows);

  sumEl.textContent = `ボンベ設置一覧：${rows.length}件（クリックで移動）`;

  if (rows.length === 0) {
    listEl.innerHTML = `<div style="color:#666; font-size:0.95rem;">該当なし</div>`;
    return;
  }

  for (const r of rows) {
    const mhName = (r["備考"] || "").trim();
    const cable = (r["ケーブル名"] || "").toString();
    const station = (r["収容局"] || "").toString();
    const lat = parseFloat(r["緯度"]);
    const lng = parseFloat(r["経度"]);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = `${mhName}（${station} / ${cable}）`;
    btn.onclick = () => {
      _map.setView([lat, lng], Math.max(_map.getZoom(), 16));
      const m = _markers.find(x => x.__mhName === mhName);
      if (m) m.openPopup();
    };
    listEl.appendChild(btn);
  }
}
