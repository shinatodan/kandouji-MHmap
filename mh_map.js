const firebaseConfig = {
  apiKey: "AIzaSyCi7BqLPC7hmVlPCqyFPSDYhaHjscqW_h0",
  authDomain: "mhmap-app.firebaseapp.com",
  projectId: "mhmap-app"
 };
 
 firebase.initializeApp(firebaseConfig);
 const db = firebase.firestore();
 
 let map;
 let markers=[];
 let mhData=[];
 
 let cylinderSet=new Set();
 let showCylinderOnly=false;
 let currentMH=null;
 
 init();
 
 async function init(){
 
 map=L.map("map").setView([37.9,139],13);
 
 L.tileLayer(
 "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
 ).addTo(map);
 
 await loadCylinderSet();
 
 Papa.parse("mh_data.csv",{
 
 download:true,
 header:true,
 
 complete:(res)=>{
 
 mhData=res.data;
 populateFilters();
 updateMap();
 
 }
 
 });
 
 document.getElementById("cylinderBtn").onclick=async()=>{
 
 showCylinderOnly=true;
 
 document.getElementById("cylinderPanel").style.display="block";
 
 document.body.classList.add("cylinder-open");
 document.body.classList.remove("cylinder-min");
 
 await updateMap();
 renderCylinderList();
 
 setTimeout(()=>map.invalidateSize(),100);
 
 };
 
 document.getElementById("cylinderClose").onclick=()=>{
 
 document.getElementById("cylinderPanel").style.display="none";
 
 document.body.classList.remove("cylinder-open");
 document.body.classList.remove("cylinder-min");
 
 showCylinderOnly=false;
 
 updateMap();
 
 };
 
 document.getElementById("cylinderMin").onclick=()=>{
 
 document.body.classList.toggle("cylinder-min");
 
 setTimeout(()=>map.invalidateSize(),100);
 
 };
 
 document.getElementById("clearBtn").onclick=()=>{
 
 showCylinderOnly=false;
 
 document.body.classList.remove("cylinder-open");
 document.body.classList.remove("cylinder-min");
 
 document.getElementById("cylinderPanel").style.display="none";
 
 updateMap();
 
 };
 
 }
 
 async function loadCylinderSet(){
 
 const snap=await db.collection("mhDetails")
 .where("cylinderInstalled","==",true)
 .get();
 
 snap.forEach(doc=>cylinderSet.add(doc.id));
 
 }
 
 function populateFilters(){
 
 const station=new Set();
 
 mhData.forEach(r=>station.add(r["収容局"]));
 
 const sel=document.getElementById("stationFilter");
 
 station.forEach(s=>{
 
 const o=document.createElement("option");
 o.text=s;
 sel.appendChild(o);
 
 });
 
 }
 
 function clearMarkers(){
 
 markers.forEach(m=>map.removeLayer(m));
 markers=[];
 
 }
 
 function sortRows(rows){
 
 return rows.sort((a,b)=>{
 
 const a1=a["ケーブル名"]||"";
 const b1=b["ケーブル名"]||"";
 
 return a1.localeCompare(b1,"ja");
 
 });
 
 }
 
 async function updateMap(){
 
 clearMarkers();
 
 let rows;
 
 if(showCylinderOnly){
 
 rows=mhData.filter(r=>cylinderSet.has(r["備考"]));
 
 }else{
 
 const st=document.getElementById("stationFilter").value;
 
 if(!st)return;
 
 rows=mhData.filter(r=>r["収容局"]===st);
 
 }
 
 rows=sortRows(rows);
 
 rows.forEach(r=>{
 
 const lat=parseFloat(r["緯度"]);
 const lng=parseFloat(r["経度"]);
 
 if(!lat||!lng)return;
 
 const name=r["備考"];
 
 const hasCylinder=cylinderSet.has(name);
 
 const icon=L.icon({
 
 iconUrl:hasCylinder?
 "https://maps.google.com/mapfiles/ms/icons/red-dot.png":
 "https://maps.google.com/mapfiles/ms/icons/blue-dot.png",
 
 iconSize:[32,32]
 
 });
 
 const m=L.marker([lat,lng],{icon}).addTo(map);
 
 m.bindPopup(name);
 
 m.__name=name;
 
 m.on("click",()=>openModal(name));
 
 markers.push(m);
 
 });
 
 }
 
 function renderCylinderList(){
 
 const list=document.getElementById("cylinderList");
 
 list.innerHTML="";
 
 const rows=sortRows(
 mhData.filter(r=>cylinderSet.has(r["備考"]))
 );
 
 rows.forEach(r=>{
 
 const btn=document.createElement("button");
 
 btn.textContent=r["備考"];
 
 btn.onclick=()=>{
 
 map.setView([
 parseFloat(r["緯度"]),
 parseFloat(r["経度"])
 ],17);
 
 const m=markers.find(x=>x.__name===r["備考"]);
 
 if(m)m.openPopup();
 
 };
 
 list.appendChild(btn);
 
 });
 
 }
 
 function openModal(name){
 
 currentMH=name;
 
 document.getElementById("modalTitle").textContent=name;
 
 document.getElementById("mhModal").style.display="block";
 
 }
 
 document.getElementById("saveBtn").onclick=async()=>{
 
 await db.collection("mhDetails")
 .doc(currentMH)
 .set({
 
 cylinderInstalled:
 document.getElementById("cylinderYes").checked
 
 });
 
 await loadCylinderSet();
 
 updateMap();
 renderCylinderList();
 
 document.getElementById("mhModal").style.display="none";
 
 };
 