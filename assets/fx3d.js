/* Blue Glass Light effects — no libraries, ~4KB. Safe: does nothing if reduced-motion is on. */
(function(){
  "use strict";
  if(window.__fx3d)return;window.__fx3d=1;
  var reduce=window.matchMedia&&matchMedia("(prefers-reduced-motion:reduce)").matches;
  var touch=window.matchMedia&&matchMedia("(hover:none)").matches;
  var SEL=".stat-card,.card,.quick,.network-card,.plan-card,.dx-card";

  /* ---------- 1) 3D tilt + moving light on cards (desktop hover only) ---------- */
  if(!reduce&&!touch){
    var cur=null;
    document.addEventListener("pointermove",function(e){
      var t=e.target&&e.target.closest?e.target.closest(SEL):null;
      if(cur&&cur!==t)reset(cur);
      cur=t;if(!t)return;
      var r=t.getBoundingClientRect();
      if(r.width>720||r.height>520){ /* big cards: only light, no tilt */
        t.style.setProperty("--mx",(e.clientX-r.left)+"px");t.style.setProperty("--my",(e.clientY-r.top)+"px");return;
      }
      var px=(e.clientX-r.left)/r.width,py=(e.clientY-r.top)/r.height;
      var ry=(px-.5)*12,rx=(.5-py)*12;
      t.style.transform="perspective(900px) rotateX("+rx.toFixed(2)+"deg) rotateY("+ry.toFixed(2)+"deg) translateY(-4px)";
      t.style.setProperty("--mx",(px*100)+"%");t.style.setProperty("--my",(py*100)+"%");
    },{passive:true});
    document.addEventListener("pointerleave",function(){if(cur)reset(cur);cur=null;},true);
    function reset(el){el.style.transform="";}
  }

  /* ---------- 2) Floating 3D shapes background (canvas) ---------- */
  if(reduce)return;
  var cv=document.createElement("canvas");cv.id="fx3d";
  var host=document.body;host.insertBefore(cv,host.firstChild);
  var ctx=cv.getContext("2d");if(!ctx)return;
  var W=0,H=0,dpr=Math.min(window.devicePixelRatio||1,2);
  function size(){W=innerWidth;H=innerHeight;cv.width=W*dpr;cv.height=H*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);}
  size();addEventListener("resize",size);

  var CL=["24,196,255","29,91,255","124,92,255","15,47,184","255,176,32"];
  var CD=["45,226,230","160,107,255","255,95,184","109,123,255","255,194,74"];
  function dark(){return document.documentElement.getAttribute("data-theme")==="dark";}
  var N=touch?9:16,items=[];
  function mk(i){
    return{x:Math.random()*W,y:Math.random()*H,z:Math.random()*.8+.2,
      s:(18+Math.random()*34),rx:Math.random()*6.28,ry:Math.random()*6.28,
      vx:(Math.random()-.5)*.25,vy:(Math.random()-.5)*.25,
      vrx:(Math.random()-.5)*.012,vry:(Math.random()-.5)*.012,
      c:i%5,t:i%3}; /* 0 cube, 1 octahedron, 2 ring */
  }
  for(var i=0;i<N;i++)items.push(mk(i));

  var CUBE=[[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]];
  var CE=[[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
  var OCT=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  var OE=[[0,2],[0,3],[0,4],[0,5],[1,2],[1,3],[1,4],[1,5],[2,4],[4,3],[3,5],[5,2]];

  function rot(p,ax,ay){
    var x=p[0],y=p[1],z=p[2],c=Math.cos(ax),s=Math.sin(ax),y1=y*c-z*s,z1=y*s+z*c;
    c=Math.cos(ay);s=Math.sin(ay);var x2=x*c+z1*s,z2=-x*s+z1*c;return[x2,y1,z2];
  }
  function draw(it){
    var dk=dark(),a=dk?.10+it.z*.22:.16+it.z*.30,col="rgba("+(dk?CD:CL)[it.c]+",";
    ctx.lineWidth=1.1;ctx.strokeStyle=col+a+")";ctx.shadowColor=col+(dk?"0.55)":"0.35)");ctx.shadowBlur=(dk?10:8)*it.z;
    var sc=it.s*it.z;
    if(it.t===2){ /* 3D ring */
      ctx.beginPath();
      for(var k=0;k<=28;k++){var an=k/28*6.2832,p=rot([Math.cos(an),Math.sin(an),0],it.rx,it.ry);
        var X=it.x+p[0]*sc*1.3,Y=it.y+p[1]*sc*1.3;k?ctx.lineTo(X,Y):ctx.moveTo(X,Y);}
      ctx.stroke();return;
    }
    var V=it.t?OCT:CUBE,E=it.t?OE:CE,P=[];
    for(var i=0;i<V.length;i++){var p=rot(V[i],it.rx,it.ry);P.push([it.x+p[0]*sc,it.y+p[1]*sc]);}
    ctx.beginPath();
    for(var j=0;j<E.length;j++){ctx.moveTo(P[E[j][0]][0],P[E[j][0]][1]);ctx.lineTo(P[E[j][1]][0],P[E[j][1]][1]);}
    ctx.stroke();
  }
  var mx=0,my=0;
  addEventListener("pointermove",function(e){mx=(e.clientX/W-.5);my=(e.clientY/H-.5);},{passive:true});
  var running=true;
  document.addEventListener("visibilitychange",function(){running=!document.hidden;if(running)loop();});
  function loop(){
    if(!running)return;
    ctx.clearRect(0,0,W,H);
    for(var i=0;i<items.length;i++){
      var it=items[i];
      it.x+=it.vx+mx*it.z*.6;it.y+=it.vy+my*it.z*.6;it.rx+=it.vrx;it.ry+=it.vry;
      if(it.x<-80)it.x=W+80;if(it.x>W+80)it.x=-80;if(it.y<-80)it.y=H+80;if(it.y>H+80)it.y=-80;
      draw(it);
    }
    requestAnimationFrame(loop);
  }
  loop();
})();
