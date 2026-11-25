const root=document.querySelector("#events");
if(root){
  root.replaceChildren();
  const notice=document.createElement("div");
  notice.className="empty";
  notice.textContent="Feed Sportradar trial bersifat internal dan hanya dapat dilihat OWNER. Halaman member tidak mengakses snapshot internal.";
  root.append(notice);
}
const status=document.querySelector("#feed-status");
if(status){status.dataset.state="error";const label=status.querySelector("span");if(label)label.textContent="Preview khusus OWNER";}
const count=document.querySelector("#event-count");if(count)count.textContent="—";
const updated=document.querySelector("#updated-at");if(updated)updated.textContent="—";
const notice=document.querySelector("#notice");
if(notice)notice.textContent="Data provider trial tidak dipublikasikan kepada member. Gunakan Sportsbook Preview di panel OWNER untuk memeriksa snapshot worker. Penerimaan taruhan tetap dinonaktifkan.";
const refresh=document.querySelector("#refresh");if(refresh)refresh.hidden=true;
