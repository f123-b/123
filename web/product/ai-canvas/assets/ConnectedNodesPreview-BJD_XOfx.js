import{A as e,C as t,S as n,T as r,v as i}from"./main-DBgCzxUL.js";import{i as a}from"./core-BQmcC1Ns.js";import{r as o}from"./viewportVideoResource-DwYvioJm.js";import{c as s,ps as c}from"./useReferencedImageWatcher-DPFOpXdn.js";import{Pt as l}from"./useTooltipAutoPlacement-9UFHOG6K.js";import{t as u}from"./FullscreenOverlay-B1NXz_Cr.js";var d=e(r(),1),f=t();function p(e,t,n){let r=e.find(e=>e.id===n),i=new Set([n,...r?.parentId?[r.parentId]:[]]),a=new Map(e.map(e=>[e.id,e])),o=new Map;for(let n of t){if(!i.has(n.target))continue;let t=a.get(n.source),r=t?.type===`group`?e.filter(e=>e.parentId===t.id).map(e=>e.id):[n.source];for(let e of r){let t=o.get(e)??[];t.push(n.id),o.set(e,t)}}return o}function m(e,t,n,r,i=48){if(t===null||e===t)return 0;let a=e-t,o=Math.abs(a),s=Math.sign(a),c=i*(n-1)/2,l=i*(r-1),u=o===1?l/2:0;return s*(c+(o>1?l:0)+u)}function h(e,t=500,n=8){let r=null,i=null,a=()=>{r!==null&&clearTimeout(r),r=null,i=null};return{start:(n,o)=>(a(),o.button!==0||!o.isPrimary?!1:(i={item:n,pointerId:o.pointerId,clientX:o.clientX,clientY:o.clientY},r=setTimeout(()=>{if(!i)return;let t=i.item;r=null,i=null,e(t)},t),!0)),move:e=>{!i||i.pointerId!==e.pointerId||Math.hypot(e.clientX-i.clientX,e.clientY-i.clientY)>n&&a()},end:e=>{i?.pointerId===e&&a()},cancel:a,dispose:a}}var g=n(),_=500,v=typeof window<`u`&&`__TAURI_INTERNALS__`in window;function y(e){if(!(!e||!v))try{return a(e)}catch{return}}var b={image:`🖼`,video:`🎬`,audio:`🎵`,text:`T`,shotlist:`▦`};function x({nodeId:e,onInsertMention:t,hoverEmphasis:n=`default`}){let r=i(),{nodes:a,edges:v}=s(l(e=>({nodes:e.nodes,edges:e.edges}))),x=s(e=>e.hoveredMentionNodeId),S=s(e=>e.currentProjectId),[C,w]=(0,d.useState)(null),[T,E]=(0,d.useState)(null),D=(0,d.useCallback)(()=>{w(null),E(null)},[]),[O,k]=(0,d.useState)(null),[A,j]=(0,d.useState)(null),M=(0,d.useRef)(null),N=(0,d.useRef)(null),P=(0,d.useRef)(null),[F,I]=(0,d.useState)(null),L=(0,d.useCallback)(()=>{N.current!==null&&clearTimeout(N.current),N.current=null,P.current=null,I(null)},[]),R=(0,d.useCallback)((e,t)=>{L(),P.current=e,N.current=setTimeout(()=>{N.current=null,!(P.current!==e||!e.isConnected)&&I({id:t,rect:e.getBoundingClientRect()})},_)},[L]);(0,d.useEffect)(()=>()=>{N.current!==null&&clearTimeout(N.current)},[]);let z=(0,d.useCallback)(()=>{M.current=setTimeout(()=>k(null),120)},[k]),B=(0,d.useCallback)(()=>{M.current&&=(clearTimeout(M.current),null)},[]);(0,d.useEffect)(()=>()=>{M.current&&clearTimeout(M.current)},[]);let V=(0,d.useMemo)(()=>{if(!e)return[];let t=p(a,v,e);return a.filter(n=>n.id!==e&&n.type!==`group`&&t.has(n.id)).map(e=>{let n=e.data,i=n.type===`ai-shotlist`,a=i?n.shotlistRows?.length??0:0,o=n.type===`ai-director`||e.type===`ai-director`?n.imageUrl||(Array.isArray(n.directorCaptureUrls)?n.directorCaptureUrls[0]:void 0):void 0,s=i?`shotlist`:n.imageUrl||o?`image`:n.videoUrl?`video`:n.audioUrl?`audio`:`text`,c=s===`image`?y(n.filePath)||n.thumbnailUrl||n.imageUrl||o||void 0:s===`video`&&n.thumbnailUrl||void 0,l=n.output?String(n.output):void 0,u=s===`text`&&l?l.slice(0,50):void 0,d=s===`image`?y(n.filePath)||n.imageUrl||o||c:s===`video`?n.videoUrl:s===`audio`?n.audioUrl:void 0,f,p,m;if(n.type===`ai-storyboard`){let t=Math.max(1,n.storyboardCols||3),i=Math.max(1,n.storyboardRows||3);p=t,m=i;let a=n.storyboardExtracted??[],o=n.storyboardOverrides??[],s=(n.storyboardRowPositions?.length||0)>0||(n.storyboardColPositions?.length||0)>0,c=s?[0,...n.storyboardRowPositions??[],100]:[],l=s?[0,...n.storyboardColPositions??[],100]:[];f=[];for(let n=0;n<i;n++)for(let u=0;u<t;u++){let d=n*t+u;if(a[d]&&!o[d])continue;let p=o[d],m={};if(!p){let e=s?l[u]:u/t*100,r=s?c[n]:n/i*100,a=s?l[u+1]-l[u]:100/t,o=s?c[n+1]-c[n]:100/i;m={backgroundSize:`${100/a*100}% ${100/o*100}%`,backgroundPosition:`${e*100/(100-a)}% ${r*100/(100-o)}%`}}f.push({idx:d,r:n,c:u,label:r(`第{row}行{col}列`,{row:n+1,col:u+1}),mentionId:`${e.id}/cell/${d}`,bgStyle:m,overrideUrl:p?.url})}}return{id:e.id,edgeIds:t.get(e.id)??[],label:n.label||r(`节点`),displayId:n.displayId,outputType:s,thumbnailUrl:c,textSnippet:u,previewText:l,mediaUrl:d,shotCount:a,hasOutput:i?a>0:!!n.output,nodeType:n.type,status:n.status,sbCells:f,sbCols:p,sbRows:m}})},[e,a,v,r]),[H,U]=(0,d.useState)(null),W=(0,d.useCallback)(e=>U(e),[]),G=(0,d.useCallback)(()=>U(null),[]),[K]=(0,d.useState)(()=>h(e=>{E(e.id),U(null),w(e)}));if((0,d.useEffect)(()=>()=>K.dispose(),[K]),V.length===0)return null;let q=(e,n)=>{t?.(`@{${e}:${n}}`)},J=t=>{let n=s.getState();if(n.currentProjectId!==S||!e)return;let r=new Set(n.edges.map(e=>e.id)),i=t.filter(e=>r.has(e)).map(e=>({type:`remove`,id:e}));i.length>0&&n.onEdgesChange(i)},Y=x?V.findIndex(e=>e.id===x||e.sbCells?.some(e=>e.mentionId===x)):-1,X=H===null?Y>=0?Y:null:H,Z=n===`expanded`,Q=Z?2.5:1.22,$=Z?1.16:1.1,ee=e=>{if(H===null)return 1;let t=Math.abs(e-H);return t===0?Q:t===1?$:1},te=e=>{if(H===null)return 0;if(Z)return m(e,H,Q,$);let t=e-H,n=Math.abs(t);return n===0?0:n===1?t*12:n===2?t*5:0};return(0,g.jsxs)(`div`,{className:`connected-nodes-float`,children:[C===null&&(0,g.jsx)(`div`,{className:`connected-nodes-strip`,children:V.map((e,t)=>{let n=ee(t),i=te(t),a=X===t,s=e.nodeType===`ai-storyboard`,c=e.nodeType===`ai-shotlist`,l=!!(e.mediaUrl||e.thumbnailUrl||e.previewText),u=`${e.label}${e.displayId==null?``:` #${e.displayId}`}`,d=l?`${r(`点击引用`)} · ${r(`长按全屏显示`)}`:r(`点击引用`);return(0,g.jsxs)(o.div,{className:`connected-node-thumb ${e.hasOutput?``:`thumb-idle`} thumb-${e.outputType}${s?` thumb-storyboard`:``}${c?` thumb-shotlist`:``}${Z?` origin-bottom`:``}`,onHoverStart:()=>W(t),onHoverEnd:G,onMouseEnter:t=>{s&&e.sbCells?(B(),k(e.id),j(t.currentTarget.getBoundingClientRect())):e.outputType===`image`&&e.thumbnailUrl&&R(t.currentTarget,e.id)},onMouseLeave:()=>{L(),s&&z()},animate:{scale:n,x:i,y:a&&!Z?-4:0,opacity:a?1:.85,boxShadow:a?`0 6px 20px rgba(99,102,241,0.25), 0 0 0 2px rgba(99,102,241,0.35)`:`0 0 0 0px rgba(99,102,241,0)`,borderColor:a?`rgba(99,102,241,0.6)`:`rgba(195,195,202,0.33)`},whileTap:{scale:n*.92},transition:{type:`spring`,stiffness:350,damping:20,mass:.7},children:[(0,g.jsxs)(`button`,{type:`button`,className:`connected-node-action`,"data-tooltip":e.outputType===`image`&&e.thumbnailUrl&&!e.sbCells?void 0:`${u} — ${d}`,"data-tooltip-label":e.outputType===`image`&&e.thumbnailUrl&&!e.sbCells?void 0:`${u} —`,"data-tooltip-action":e.outputType===`image`&&e.thumbnailUrl&&!e.sbCells?void 0:d,"aria-label":`${u} — ${d}`,onClick:()=>{if(T===e.id){E(null);return}q(e.id,e.label)},onPointerDown:t=>{L(),l&&K.start(e,t)&&t.currentTarget.setPointerCapture(t.pointerId)},onPointerMove:e=>K.move(e),onPointerUp:t=>{K.end(t.pointerId),window.setTimeout(()=>{E(t=>t===e.id?null:t)},0)},onPointerCancel:e=>K.end(e.pointerId),onLostPointerCapture:K.cancel,onContextMenu:e=>{l&&e.preventDefault()},children:[e.outputType===`image`&&e.thumbnailUrl?(0,g.jsx)(`img`,{src:e.thumbnailUrl,alt:e.label,className:`thumb-img`,loading:`lazy`}):e.outputType===`video`&&e.thumbnailUrl?(0,g.jsxs)(`div`,{className:`thumb-video-wrap`,children:[(0,g.jsx)(`img`,{src:e.thumbnailUrl,alt:e.label,className:`thumb-img`,loading:`lazy`}),(0,g.jsx)(`span`,{className:`thumb-play-icon`,children:`▶`})]}):e.outputType===`text`&&e.textSnippet?(0,g.jsx)(`span`,{className:`thumb-text`,children:e.textSnippet}):(0,g.jsx)(`span`,{className:`thumb-icon thumb-icon-${e.outputType}`,children:b[e.outputType]||`?`}),s&&e.sbCells&&(0,g.jsx)(`span`,{className:`thumb-sb-badge`,children:e.sbCells.length}),c&&e.shotCount>0&&(0,g.jsx)(`span`,{className:`thumb-shot-badge`,children:e.shotCount}),e.status===`loading`&&(0,g.jsx)(`div`,{className:`thumb-loading`,children:(0,g.jsx)(`span`,{className:`thumb-spinner`})})]}),(0,g.jsx)(o.button,{type:`button`,className:`connected-node-disconnect`,"aria-label":`${r(`断开上游连线`)}：${e.label}`,animate:{scale:1/n},transition:{type:`spring`,stiffness:350,damping:20,mass:.7},onPointerDown:e=>e.stopPropagation(),onClick:t=>{t.preventDefault(),t.stopPropagation(),L(),B(),k(null),J(e.edgeIds)},children:(0,g.jsx)(`img`,{src:`data:image/svg+xml,%3csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%201024%201024'%3e%3ccircle%20cx='512'%20cy='512'%20r='397'%20fill='%23D9D9D9'%20/%3e%3cpath%20d='M512%20929.959184c-230.4%200-417.959184-187.559184-417.959184-417.959184s187.559184-417.959184%20417.959184-417.959184%20417.959184%20187.559184%20417.959184%20417.959184-187.559184%20417.959184-417.959184%20417.959184z%20m0-794.122449c-207.412245%200-376.163265%20168.75102-376.163265%20376.163265s168.75102%20376.163265%20376.163265%20376.163265%20376.163265-168.75102%20376.163265-376.163265-168.75102-376.163265-376.163265-376.163265z'%20fill='%23333333'%20/%3e%3cpath%20d='M355.265306%20689.632653c-5.22449%200-10.44898-2.089796-14.628571-6.269388-8.359184-8.359184-8.359184-21.420408%200-29.779592l313.469387-313.469387c8.359184-8.359184%2021.420408-8.359184%2029.779592%200%208.359184%208.359184%208.359184%2021.420408%200%2029.779592l-313.469387%20313.469387c-4.702041%204.179592-9.926531%206.269388-15.151021%206.269388z'%20fill='%23333333'%20/%3e%3cpath%20d='M668.734694%20689.632653c-5.22449%200-10.44898-2.089796-14.628572-6.269388l-313.469387-313.469387c-8.359184-8.359184-8.359184-21.420408%200-29.779592%208.359184-8.359184%2021.420408-8.359184%2029.779592%200l313.469387%20313.469387c8.359184%208.359184%208.359184%2021.420408%200%2029.779592-4.702041%204.179592-9.926531%206.269388-15.15102%206.269388z'%20fill='%23333333'%20/%3e%3c/svg%3e`,alt:``,"aria-hidden":`true`})})]},e.id)})}),(0,f.createPortal)((0,g.jsx)(c,{children:C===null&&F&&(()=>{let e=V.find(e=>e.id===F.id);if(!e?.thumbnailUrl)return null;let{rect:t}=F,n=Math.max(32,Math.min(264,window.innerWidth-24,t.top-20));return(0,g.jsx)(`div`,{className:`connected-image-preview-anchor`,style:{left:Math.min(Math.max(t.left+t.width/2,n/2+12),window.innerWidth-n/2-12),top:t.top-8,width:n,height:n},children:(0,g.jsx)(o.div,{className:`connected-image-preview`,initial:{opacity:0,y:4},animate:{opacity:1,y:0},exit:{opacity:0,y:4},transition:{duration:.15},children:(0,g.jsx)(`img`,{src:e.mediaUrl||e.thumbnailUrl,alt:e.label})},e.id)})})()}),document.body),(0,f.createPortal)((0,g.jsx)(c,{children:C===null&&O!==null&&(()=>{let e=V.find(e=>e.id===O);if(!e?.sbCells)return null;let t=A;return(0,g.jsx)(`div`,{className:`sb-cell-anchor`,style:t?{left:`${t.left+t.width/2}px`,top:`${t.top-8}px`,transform:`translate(-50%, -100%)`}:{bottom:72,left:`50%`,transform:`translateX(-50%)`},onMouseEnter:B,onMouseLeave:()=>{k(null)},children:(0,g.jsx)(o.div,{className:`sb-cell-popup`,initial:{opacity:0,y:4,scale:.96},animate:{opacity:1,y:0,scale:1},exit:{opacity:0,y:4,scale:.96},transition:{duration:.18},children:(0,g.jsx)(`div`,{className:`sb-cell-grid`,style:{gridTemplateColumns:`repeat(${e.sbCols}, 1fr)`},children:e.sbCells.map(t=>(0,g.jsxs)(`button`,{type:`button`,className:`sb-cell-item`,title:`${e.label} · ${t.label}`,onClick:n=>{n.stopPropagation(),q(t.mentionId,`${e.label} · ${t.label}`)},children:[t.overrideUrl?(0,g.jsx)(`img`,{src:t.overrideUrl,alt:t.label,className:`sb-cell-img`}):e.thumbnailUrl?(0,g.jsx)(`div`,{className:`sb-cell-sprite`,style:{backgroundImage:`url(${e.thumbnailUrl})`,...t.bgStyle}}):(0,g.jsxs)(`span`,{className:`sb-cell-placeholder`,children:[t.r+1,`,`,t.c+1]}),(0,g.jsx)(`span`,{className:`sb-cell-label`,children:t.label})]},t.idx))})},`sb-popup-${O}`)})})()}),document.body),(0,g.jsx)(u,{isOpen:C!==null,onClose:D,hidePanel:!0,title:C?.label,className:`fullscreen-overlay--image-preview`,children:C&&(0,g.jsxs)(`div`,{className:`fixed inset-0 flex flex-col items-center justify-center gap-4 px-10 py-12`,onClick:e=>e.stopPropagation(),children:[(0,g.jsx)(`div`,{className:`flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden rounded-2xl`,children:C.outputType===`image`&&(C.mediaUrl||C.thumbnailUrl)?(0,g.jsx)(`img`,{src:C.mediaUrl||C.thumbnailUrl,alt:C.label,className:`max-h-full max-w-full select-none rounded-2xl object-contain shadow-2xl`,draggable:!1}):C.outputType===`video`&&C.mediaUrl?(0,g.jsx)(`video`,{src:C.mediaUrl,className:`max-h-full max-w-full rounded-2xl bg-black shadow-2xl`,controls:!0,autoPlay:!0}):C.outputType===`audio`&&C.mediaUrl?(0,g.jsxs)(`div`,{className:`flex w-full max-w-xl flex-col items-center gap-5 rounded-2xl border border-canvas-border bg-canvas-surface/90 p-8 shadow-2xl backdrop-blur-xl`,children:[(0,g.jsx)(`span`,{className:`text-5xl`,"aria-hidden":`true`,children:`🎵`}),(0,g.jsx)(`audio`,{src:C.mediaUrl,className:`w-full`,controls:!0,autoPlay:!0})]}):C.outputType===`video`&&C.thumbnailUrl?(0,g.jsx)(`img`,{src:C.thumbnailUrl,alt:C.label,className:`max-h-full max-w-full select-none rounded-2xl object-contain shadow-2xl`,draggable:!1}):(0,g.jsx)(`div`,{className:`max-h-full w-full max-w-3xl overflow-y-auto rounded-2xl border border-canvas-border bg-canvas-surface/90 p-6 text-sm leading-7 text-canvas-text shadow-2xl backdrop-blur-xl`,children:C.previewText||r(`暂无可预览内容`)})}),(0,g.jsxs)(`div`,{className:`flex shrink-0 flex-col items-center gap-2`,children:[(0,g.jsxs)(`span`,{className:`max-w-[70vw] truncate text-xs text-white/70`,children:[C.label,C.displayId==null?``:` #${C.displayId}`]}),(0,g.jsx)(`button`,{type:`button`,className:`inline-flex min-h-10 items-center justify-center rounded-xl bg-indigo-500 px-5 text-sm font-medium text-white shadow-lg transition-[transform,background-color] duration-150 ease-out hover:bg-indigo-400 active:scale-[.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300`,onClick:()=>{q(C.id,C.label),D()},children:r(`单击引用`)})]})]})}),(0,g.jsx)(`style`,{children:`
        .connected-nodes-float {
          position: relative;
          width: 540px;
          max-width: calc(100vw - 32px);
          background: transparent;
          padding: 0 14px;
        }
        .connected-nodes-strip {
          display: flex;
          gap: 6px;
          scrollbar-width: thin;
          scrollbar-color: var(--theme-border) transparent;
        }
        .connected-nodes-strip::-webkit-scrollbar { height: 3px; }
        .connected-nodes-strip::-webkit-scrollbar-track { background: transparent; }
        .connected-nodes-strip::-webkit-scrollbar-thumb { background: var(--theme-border); border-radius: 8px; }
        .connected-node-thumb {
          flex-shrink: 0;
          width: 48px; height: 48px;
          border-radius: 8px;
          border: 2px solid rgba(195,195,202,0.33);
          background: var(--theme-surface);
          overflow: hidden; position: relative; padding: 0;
        }
        .connected-node-action {
          display: flex; align-items: center; justify-content: center;
          width: 100%; height: 100%; padding: 0; border: 0;
          background: transparent;
          cursor: var(--cursor-pointer, pointer);
        }
        .connected-node-disconnect {
          position: absolute; top: 1px; right: 1px; z-index: 3;
          display: flex; align-items: center; justify-content: center;
          width: 20px; height: 20px; padding: 0;
          border: 0; border-radius: 4px;
          background: transparent;
          cursor: var(--cursor-pointer, pointer);
          opacity: 0; pointer-events: none;
          transform-origin: top right;
        }
        .connected-node-thumb:hover .connected-node-disconnect,
        .connected-node-thumb:focus-within .connected-node-disconnect {
          opacity: 1; pointer-events: auto;
        }
        .connected-node-disconnect img { width: 18px; height: 18px; display: block; }
        .connected-node-thumb.thumb-storyboard { border-color: rgba(244,114,182,0.45); }
        /* 分镜表：沿用节点自身的琥珀色，和文本节点区分开 */
        .connected-node-thumb.thumb-shotlist {
          border-color: rgba(251,191,36,0.5);
          background: rgba(251,191,36,0.08);
        }
        .thumb-img {
          width: 100%; height: 100%; object-fit: cover; border-radius: 6px;
        }
        .connected-image-preview-anchor {
          position: fixed;
          z-index: 10050;
          transform: translate(-50%, -100%);
          pointer-events: none;
        }
        .connected-image-preview {
          width: 100%; height: 100%;
          border-radius: 8px;
          overflow: hidden;
          box-shadow: 0 8px 24px var(--black-alpha-50);
        }
        .connected-image-preview img {
          display: block;
          width: 100%; height: 100%; object-fit: cover;
        }
        .thumb-video-wrap {
          position: relative; width: 100%; height: 100%;
          display: flex; align-items: center; justify-content: center;
        }
        .thumb-video-wrap .thumb-img { position: absolute; inset: 0; width: 100%; height: 100%; }
        .thumb-play-icon {
          position: relative; z-index: 1; font-size: 12px;
          color: rgba(255,255,255,0.9); text-shadow: 0 1px 3px var(--black-alpha-50); pointer-events: none;
        }
        .thumb-icon { font-size: 14px; font-weight: 600; opacity: 0.5; }
        .thumb-icon-image { color: var(--success-text); }
        .thumb-icon-video { color: var(--node-video-light); }
        .thumb-icon-audio { color: var(--node-audio-light); }
        .thumb-icon-text  { color: var(--brand-hover); }
        .thumb-icon-shotlist { color: #fbbf24; opacity: 0.9; font-size: 16px; }
        .thumb-text {
          font-size: 4px; line-height: 1.2; color: var(--theme-text-secondary);
          padding: 1px; display: -webkit-box;
          -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; word-break: break-all;
        }
        .thumb-loading {
          position: absolute; inset: 0;
          background: var(--black-alpha-50);
          display: flex; align-items: center; justify-content: center;
        }
        .thumb-spinner {
          width: 12px; height: 12px;
          border: 2px solid rgba(255,255,255,0.2); border-top-color: #fff;
          border-radius: 50%; animation: thumb-spin 0.6s linear infinite;
        }
        @keyframes thumb-spin { to { transform: rotate(360deg); } }

        /* ── 宫格角标 ── */
        .thumb-sb-badge {
          position: absolute; bottom: -1px; right: -1px;
          min-width: 16px; height: 16px; padding: 0 4px;
          font-size: 10px; font-weight: 600; line-height: 16px;
          color: #fff; background: #db2777; border-radius: 6px 0 6px 0;
          z-index: 2;
        }

        /* ── 分镜表角标 ── */
        .thumb-shot-badge {
          position: absolute; bottom: -1px; right: -1px;
          min-width: 16px; height: 16px; padding: 0 4px;
          font-size: 10px; font-weight: 600; line-height: 16px;
          color: #1c1300; background: #fbbf24; border-radius: 6px 0 6px 0;
          z-index: 2;
        }

        /* ── 宫格弹出浮层 ── */
        .sb-cell-anchor {
          position: fixed;
          z-index: 9999;
        }
        .sb-cell-popup {
          max-width: calc(100vw - 24px);
          background: var(--theme-card);
          border: 1px solid var(--theme-border);
          border-radius: 12px;
          padding: 10px;
          box-shadow: 0 12px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(244,114,182,0.2);
        }
        .sb-cell-grid {
          display: grid;
          gap: 5px;
        }
        .sb-cell-item {
          position: relative;
          width: 54px; height: 54px;
          border-radius: 6px;
          border: 1.5px solid rgba(195,195,202,0.28);
          overflow: hidden;
          cursor: var(--cursor-pointer, pointer);
          background: var(--theme-surface);
          padding: 0;
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .sb-cell-item:hover {
          border-color: rgba(244,114,182,0.6);
          box-shadow: 0 0 12px rgba(244,114,182,0.2);
        }
        .sb-cell-img {
          width: 100%; height: 100%; object-fit: cover; border-radius: 4px;
        }
        .sb-cell-sprite {
          width: 100%; height: 100%;
          background-repeat: no-repeat;
          border-radius: 4px;
        }
        .sb-cell-placeholder {
          display: flex; align-items: center; justify-content: center;
          font-size: 12px; color: var(--theme-text-muted);
          width: 100%; height: 100%;
        }
        .sb-cell-label {
          position: absolute; bottom: 2px; left: 2px;
          font-size: 9px; line-height: 13px; padding: 0 4px;
          color: rgba(255,255,255,0.85);
          background: rgba(0,0,0,0.55);
          border-radius: 3px;
          pointer-events: none;
        }
      `})]})}export{x as t};