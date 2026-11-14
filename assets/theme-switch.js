/* Light <-> Dark theme switch. Default = Light. Choice is saved in localStorage ("mbc_theme"). */
(function(){
  "use strict";
  var KEY="mbc_theme";
  var tg=window.Telegram&&window.Telegram.WebApp;
  function isDark(){try{return localStorage.getItem(KEY)==="dark"}catch(e){return false}}
  function apply(dark,save){
    window.MBC_DARK=dark;
    if(save){try{localStorage.setItem(KEY,dark?"dark":"light")}catch(e){}}
    document.documentElement.setAttribute("data-theme",dark?"dark":"light");
    var link=document.getElementById("themeCss");
    if(link){var want="/assets/theme"+(dark?"-dark":"")+".css";if(link.getAttribute("href")!==want)link.setAttribute("href",want);}
    var m=document.querySelector('meta[name="theme-color"]');if(m)m.content=dark?"#05060d":"#f4f8ff";
    var c=document.querySelector('meta[name="color-scheme"]');if(c)c.content=dark?"dark":"light";
    try{if(tg){tg.setHeaderColor(dark?"#050b1f":"#f4f8ff");tg.setBackgroundColor(dark?"#050b1f":"#f4f8ff");}}catch(e){}
    var b=document.getElementById("themeBtn");
    if(b){b.textContent=dark?"☀":"☾";b.title=dark?"Switch to Light theme":"Switch to Dark theme";b.setAttribute("aria-label",b.title);}
  }
  var st=document.createElement("style");st.textContent=".top-actions #themeBtn{display:grid;place-items:center;font-size:16px;line-height:1}";document.head.appendChild(st); /* keep visible on phones */
  function mount(){
    var host=document.querySelector(".top-actions");if(!host||document.getElementById("themeBtn"))return;
    var b=document.createElement("button");b.className="icon-btn";b.id="themeBtn";b.type="button";
    b.addEventListener("click",function(){apply(!window.MBC_DARK,true)});
    host.insertBefore(b,document.getElementById("profileBadge")||null);
    apply(isDark(),false);
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",mount);else mount();
})();
