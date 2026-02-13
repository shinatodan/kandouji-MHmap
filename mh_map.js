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

// Leafletインスタンスを他スクリプトでも触れるように（任意）
Object.defineProperty(window, "_leafletMap", {
  get: () => _map,
  configurable: false,
});

// =========================
// ユーティリティ
// =========================
function getEl(id) { return document.getElementById(id); }

function iconUrl(hasFailure) {
  return hasFailure
    ? "https://maps.google.com/mapfiles/ms/icons/orange-dot.png"
    : "https://maps.google.com/mapfiles/ms/icons/blue-dot.png";
}

function normalizeText(s) {
  return (s ?? "").toString().trim().toLowerCase();
}

// HTML属性用の簡易エスケープ
function escapeForAttr(text) {
  return String(text).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// HTML表示用エスケープ
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

  // 地図生成
  _map = L.map("map").setView([37.9, 139.06], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors",
    maxZoom: 20,
  }).addTo(_map);

  // イベント（追加／保存）
  getEl("pressureAdd").addEventListener("click", addPressure);
  getEl("failureAdd").addEventListener("click", addFailure);
  getEl("saveBtn").addEventListener("click", saveMHDetail);

  // フィルタ変更イベント
  getEl("stationFilter").addEventListener("change", () => {
    updateCableFilter();
    updateNameOptions();
    updateMap();
  });
  getEl("cableFilter").addEventListener("change", () => {
    updateNameOptions();
    updateMap();
  });
  getEl("nameFilter").addEventListener("input", updateMap);

  // CSV読み込み
  Papa.parse("./mh_data.csv", {
    download: true,
    header: true,
    skipEmptyLines: true,
    complete: (results) => {
      _mhData = results.data || [];
      console.log("CSV loaded rows:", _mhData.length);

      populateFilters();
      updateMap();
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
function populateFilters() {
  const stationSelect = getEl("stationFilter");
  const stationSet = new Set();

  _mhData.forEach((item) => {
    if (item["収容局"]) stationSet.add(item["収容局"]);
  });

  stationSelect.innerHTML =
    `<option value="">すべて</option>` +
    [...stationSet].sort((a, b) => a.localeCompare(b, "ja"))
      .map((s) => `<option>${s}</option>`)
      .join("");

  updateCableFilter();
  updateNameOptions();
}

function updateCableFilter() {
  const selectedStation = getEl("stationFilter").value;
  const cableSelect = getEl("cableFilter");
  const cableSet = new Set();

  _mhData.forEach((row) => {
    if (!selectedStation || row["収容局"] === selectedStation) {
      if (row["ケーブル名"]) cableSet.add(row["ケーブル名"]);
    }
  });

  cableSelect.innerHTML =
    `<option value="">すべて</option>` +
    [...cableSet].sort((a, b) => a.localeCompare(b, "ja"))
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
      (!selectedStation || row["収容局"] === selectedStation) &&
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
function updateMap() {
  // 古いマーカーを削除
  _markers.forEach((m) => _map.removeLayer(m));
  _markers = [];

  const selectedStation = getEl("stationFilter").value;
  const selectedCable = getEl("cableFilter").value;
  const nameQuery = normalizeText(getEl("nameFilter")?.value);

  const filtered = _mhData.filter((row) => {
    const okStation = !selectedStation || row["収容局"] === selectedStation;
    const okCable = !selectedCable || row["ケーブル名"] === selectedCable;

    // 備考（名称）で部分一致
    const name = normalizeText(row["備考"]);
    const okName = !nameQuery || name.includes(nameQuery);

    return okStation && okCable && okName;
  });

  filtered.forEach((row) => {
    const lat = parseFloat(row["緯度"]);
    const lng = parseFloat(row["経度"]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    const mhName = (row["備考"] || "").trim();
    const popupHtml = `
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

    // mhName が空のときは Firestore の参照をスキップして青アイコン固定
    if (!mhName) {
      const marker = L.marker([lat, lng], {
        icon: L.icon({
          iconUrl: iconUrl(false),
          iconSize: [32, 32],
          iconAnchor: [16, 32],
          popupAnchor: [0, -32],
        }),
      }).addTo(_map).bindPopup(popupHtml);

      _markers.push(marker);
      return;
    }

    // Firestoreから故障有無を見てアイコン色分け
    db.collection("mhDetails").doc(mhName).get().then((doc) => {
      let hasFailure = false;
      if (doc.exists) {
        const data = doc.data() || {};
        hasFailure = data.failures && Object.keys(data.failures).length > 0;
      }

      const marker = L.marker([lat, lng], {
        icon: L.icon({
          iconUrl: iconUrl(hasFailure),
          iconSize: [32, 32],
          iconAnchor: [16, 32],
          popupAnchor: [0, -32],
        }),
      }).addTo(_map).bindPopup(popupHtml);

      _markers.push(marker);
    }).catch((err) => {
      console.warn("Firestore 取得失敗:", err);

      const marker = L.marker([lat, lng], {
        icon: L.icon({
          iconUrl: iconUrl(false),
          iconSize: [32, 32],
          iconAnchor: [16, 32],
          popupAnchor: [0, -32],
        }),
      }).addTo(_map).bindPopup(popupHtml);

      _markers.push(marker);
    });
  });
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

  const modal = getEl("mhModal");

  if (!mhName) { // 名前が無い場合は編集不可に
    modal.style.display = "block";
    return;
  }

  db.collection("mhDetails").doc(mhName).get().then(doc => {
    if (doc.exists) {
      const data = doc.data() || {};
      getEl("mhSize").value = data.size || "";
      getEl("closureType").value = data.closure || "";

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
    <button class="delete-pressure" data-date="${escapeForAttr(date)}">削除</button>
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
    <button class="delete-failure" data-date="${escapeForAttr(date)}">削除</button>
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

  // data属性から安全に収集
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
    if (date && status != null) {
      failures[date] = { status, comment };
    }
  });

  db.collection("mhDetails").doc(_currentMHId).set({
    size, closure, pressure, failures
  }).then(() => {
    alert("保存しました");
    getEl("mhModal").style.display = "none";
    // 保存後の色分け反映のため再描画
    updateMap();
  }).catch(err => {
    console.error("保存失敗:", err);
    alert("保存に失敗しました");
  });
}
