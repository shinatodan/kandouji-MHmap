// =========================
// Firebase 初期化（compat）
// =========================
const firebaseConfig = {
  apiKey: "AIzaSyCi7BqLPC7hmVlPCyFPSDYhaHjscqW_h0",
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

// 追加：ボンベモード（収容局に関係なくボンベ設置だけ表示）
let _cylinderMode = false;

// 追加：ボンベ一覧（Firestore whereで集めたmhNameのSet）
let _cylinderSet = new Set();
// キャッシュ（短時間で連打しても重くならない）
let _cylinderFetchedAt = 0;

Object.defineProperty(window, "_leafletMap", {
  get: () => _map,
  configurable: false,
});

// =========================
// ユーティリティ
// =========================
function getEl(id) { return document.getElementById(id); }

// 既存のiconUrl(boolean)互換を維持しつつ拡張
function iconUrl(arg1, hasCylinder = false) {
  const hasFailure = !!arg1;
  if (hasCylinder) return "https://maps.google.com/mapfiles/ms/icons/red-dot.png";
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

// 追加：ボンベパネルのボタン表示を更新（閉じる/開く）
function updateCylinderToggleLabel() {
  const btn = getEl("cylinderClose");
  if (!btn) return;

  const panel = getEl("cylinderPanel");
  const isVisible = panel && panel.style.display !== "none" && panel.style.display !== "";
  const isMin = document.body.classList.contains("cylinder-min");

  // パネルが出ていない時は「開く」に寄せる（表示される状況は通常ないが保険）
  if (!isVisible) {
    btn.textContent = "開く";
    return;
  }

  btn.textContent = isMin ? "開く" : "閉じる";
}

// 追加：一覧パネル表示制御（地図が隠れないように）
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

// 追加：ボンベ設置Setをwhereで取得（収容局無関係表示用）
async function fetchCylinderSet({ force = false } = {}) {
  const TTL = 60 * 1000; // 60秒キャッシュ
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
      if (doc.id) set.add(doc.id); // doc.id = mhName（現設計）
    });
  } catch (e) {
    console.warn("ボンベ設置一覧取得失敗:", e);
  }

  _cylinderSet = set;
  _cylinderFetchedAt = now;
  return _cylinderSet;
}

// 追加：ポップアップHTML生成（既存と同じ形）
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

  // 追加：ボンベ設置個所ボタン（収容局未選択でもOK）
  getEl("cylinderBtn").addEventListener("click", async () => {
    _cylinderMode = true;
    openCylinderPanel();
    await fetchCylinderSet({ force: true });
    renderCylinderList();
    updateMap(); // ボンベ設備全件表示
  });

  // 追加：「閉じる/開く」ボタン＝最小化トグル（表示名が切り替わる）
  getEl("cylinderClose").addEventListener("click", () => {
    // パネルが出てない場合は開く（保険）
    const panel = getEl("cylinderPanel");
    const isVisible = panel && panel.style.display !== "none" && panel.style.display !== "";
    if (!isVisible) {
      openCylinderPanel();
      renderCylinderList();
      return;
    }
    toggleCylinderMinimize();
  });

  // クリア（既存の動作＋ボンベUIをリセット）
  getEl("clearBtn").addEventListener("click", () => {
    getEl("stationFilter").value = "";
    getEl("cableFilter").innerHTML = `<option value="">収容局を選択</option>`;
    getEl("cableFilter").disabled = true;

    getEl("nameFilter").value = "";
    getEl("nameFilter").disabled = true;

    // 追加：ボンベモード解除＆UIリセット
    _cylinderMode = false;
    resetCylinderUi();

    // ピンを消して初期状態へ
    clearMarkers();
    setHint("収容局を選択するとピンを表示します");
  });

  // フィルタ変更イベント（既存のまま。ただしボンベモードは解除して通常挙動へ）
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
      // ★ここでは updateMap() を呼ばない（初期ピン描画しない）
    },
    error: (err) => {
      console.error("CSV 読み込み失敗:", err);
      alert("データの読み込みに失敗しました。");
    },
  });
};

// =========================
// フィルタ構築（既存のまま）
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
// 地図描画（既存 + ボンベモード分岐のみ追加）
// =========================
function clearMarkers() {
  _markers.forEach((m) => _map.removeLayer(m));
  _markers = [];
}

function updateMap() {
  // 追加：ボンベモード（収容局に関係なくボンベ設置のみ表示）
  if (_cylinderMode) {
    clearMarkers();

    if (!_cylinderSet || _cylinderSet.size === 0) {
      setHint("表示件数：0（ボンベ設置のみ）");
      return;
    }

    let count = 0;

    // ★ここは「ボンベ設置されている設備すべてがピン表示」要件
    // CSV上で座標を持つ該当設備は全部表示（収容局・ケーブル・検索は関係なし）
    _mhData.forEach((row) => {
      const lat = parseFloat(row["緯度"]);
      const lng = parseFloat(row["経度"]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

      const mhName = (row["備考"] || "").trim();
      if (!mhName) return;

      if (!_cylinderSet.has(mhName)) return;

      const popupHtml = buildPopupHtml(row, lat, lng, mhName);

      const marker = L.marker([lat, lng], {
        icon: L.icon({
          iconUrl: iconUrl(false, true), // 赤固定
          iconSize: [32, 32],
          iconAnchor: [16, 32],
          popupAnchor: [0, -32],
        }),
      }).addTo(_map).bindPopup(popupHtml);

      marker.__mhName = mhName;
      _markers.push(marker);
      count++;
    });

    setHint(`表示件数：${count}（ボンベ設置のみ）`);
    return;
  }

  // ===== ここから下は既存そのまま =====
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

    db.collection("mhDetails").doc(mhName).get().then((doc) => {
      let hasFailure = false;
      let hasCylinder = false;

      if (doc.exists) {
        const data = doc.data() || {};
        hasFailure = data.failures && Object.keys(data.failures).length > 0;
        hasCylinder = data.cylinderInstalled === true;
      }

      const marker = L.marker([lat, lng], {
        icon: L.icon({
          iconUrl: iconUrl(hasFailure, hasCylinder),
          iconSize: [32, 32],
          iconAnchor: [16, 32],
          popupAnchor: [0, -32],
        }),
      }).addTo(_map).bindPopup(popupHtml);

      marker.__mhName = mhName;
      _markers.push(marker);
    }).catch((err) => {
      console.warn("Firestore 取得失敗:", err);

      const marker = L.marker([lat, lng], {
        icon: L.icon({
          iconUrl: iconUrl(false, false),
          iconSize: [32, 32],
          iconAnchor: [16, 32],
          popupAnchor: [0, -32],
        }),
      }).addTo(_map).bindPopup(popupHtml);

      marker.__mhName = mhName;
      _markers.push(marker);
    });
  });
}

// =========================
// 追加：ボンベ一覧を描画（クリックしてもピンはそのまま）
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

  // CSV順のまま抽出（既存の並びを崩さない）
  const rows = [];
  _mhData.forEach((row) => {
    const mhName = (row["備考"] || "").trim();
    if (!mhName) return;
    if (!_cylinderSet.has(mhName)) return;

    const lat = parseFloat(row["緯度"]);
    const lng = parseFloat(row["経度"]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    rows.push({ row, mhName, lat, lng });
  });

  sumEl.textContent = `ボンベ設置一覧：${rows.length}件（クリックで移動）`;

  rows.forEach(({ row, mhName, lat, lng }) => {
    const btn = document.createElement("button");
    const station = (row["収容局"] || "").toString();
    const cable = (row["ケーブル名"] || "").toString();
    btn.type = "button";
    btn.textContent = `${mhName}（${station} / ${cable}）`;

    // ★クリックしても「ボンベ全件表示」は維持（updateMap等は呼ばない）
    btn.onclick = () => {
      _map.setView([lat, lng], Math.max(_map.getZoom(), 16));
      const m = _markers.find(x => x.__mhName === mhName);
      if (m) m.openPopup();
    };

    listEl.appendChild(btn);
  });
}

// =========================
// モーダルと保存（既存 + ボンベ保存追加）
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
    size, closure, pressure, failures,
    cylinderInstalled,
  }).then(async () => {
    alert("保存しました");
    getEl("mhModal").style.display = "none";

    await fetchCylinderSet({ force: true });

    // ボンベモードなら一覧更新（ピンは全件表示のまま）
    if (_cylinderMode) {
      renderCylinderList();
      updateCylinderToggleLabel();
    }

    updateMap(); // 色分け再描画
  }).catch(err => {
    console.error("保存失敗:", err);
    alert("保存に失敗しました");
  });
}
