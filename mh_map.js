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

  // クリア
  getEl("clearBtn").addEventListener("click", () => {
    getEl("stationFilter").value = "";
    getEl("cableFilter").innerHTML = `<option value="">収容局を選択</option>`;
    getEl("cableFilter").disabled = true;

    getEl("nameFilter").value = "";
    getEl("nameFilter").disabled = true;

    // ピンを消して初期状態へ
    clearMarkers();
    setHint("収容局を選択するとピンを表示します");
  });

  // フィルタ変更イベント
  getEl("stationFilter").addEventListener("change", () => {
    const station = getEl("stationFilter").value;

    // station未選択なら描画しない
    if (!station) {
      getEl("cableFilter").innerHTML = `<option value="">収容局を選択</option>`;
      getEl("cableFilter").disabled = true;

      getEl("nameFilter").value = "";
      getEl("nameFilter").disabled = true;

      clearMarkers();
      setHint("収容局を選択するとピンを表示します");
      return;
    }

    // station選択されたらケーブル/名称を有効化して更新
    getEl("cableFilter").disabled = false;
    getEl("nameFilter").disabled = false;

    updateCableFilter();
    updateNameOptions();
    updateMap();
  });

  getEl("cableFilter").addEventListener("change", () => {
    const station = getEl("stationFilter").value;
    if (!station) return; // 念のため
    updateNameOptions();
    updateMap();
  });

  getEl("nameFilter").addEventListener("input", () => {
    const station = getEl("stationFilter").value;
    if (!station) return; // 念のため
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
      // ★ここでは updateMap() を呼ばない（初期ピン描画しない）
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
// 地図描画（収容局が未選択なら描画しない）
// =========================
function clearMarkers() {
  _markers.forEach((m) => _map.removeLayer(m));
  _markers = [];
}

function updateMap() {
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

  setHint(`表示件数：${filtered.length}（収容局を変更/ケーブル/名称で絞り込み）`);

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

  if (!mhName) {
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
    size, closure, pressure, failures
  }).then(() => {
    alert("保存しました");
    getEl("mhModal").style.display = "none";
    updateMap(); // 色分け再描画
  }).catch(err => {
    console.error("保存失敗:", err);
    alert("保存に失敗しました");
  });
}
