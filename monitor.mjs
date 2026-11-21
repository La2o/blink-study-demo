const knownFeatures = ["ear_last","ear_min","ear_mean","ear_change","ear_drop","ear_range","mar_change","mar_onset"];
const vector = (x,n) => Array.isArray(x) && x.length===n && x.every(Number.isFinite);
function validate(m) {
  const invalid = () => {throw new Error("This file is not a compatible Blink Study model.");};
  if (!m || m.schema!=="blink-study-1" || !Number.isInteger(m.horizon_ticks) ||
      m.horizon_ticks<2 || m.horizon_ticks>8 || !Number.isFinite(m.threshold) ||
      !Array.isArray(m.features) || !m.features.length || m.features.length>knownFeatures.length ||
      !m.features.every(f=>knownFeatures.includes(f))) invalid();
  const n=m.features.length;
  if (m.family==="LR" || m.family==="RBF SVM") {
    if (!vector(m.mean,n) || !vector(m.scale,n) || m.scale.some(s=>s<=0) || !Number.isFinite(m.bias)) invalid();
    if (m.family==="LR" && !vector(m.coef,n)) invalid();
    if (m.family==="RBF SVM" && (!Array.isArray(m.sv) || !m.sv.length || m.sv.length>10000 ||
      !m.sv.every(x=>vector(x,n)) || !vector(m.dual,m.sv.length) || !(m.gamma>0) || !Number.isFinite(m.gamma))) invalid();
  } else if (m.family==="RF" || m.family==="HGB") {
    if (!Array.isArray(m.trees) || !m.trees.length || m.trees.length>1000 ||
        (m.family==="HGB" && !Number.isFinite(m.bias))) invalid();
    for (const tree of m.trees) {
      const k=tree?.left?.length;
      if (!k || k>100000 || !["left","right","feature","cut","value"].every(key=>vector(tree[key],k))) invalid();
      for (let i=0;i<k;i++) if (tree.left[i]!==-1 &&
        (![tree.left[i],tree.right[i]].every(child=>Number.isInteger(child)&&child>i&&child<k) ||
         !Number.isInteger(tree.feature[i]) || tree.feature[i]<0 || tree.feature[i]>=n)) invalid();
    }
  } else invalid();
}
const sigmoid = x=>1/(1+Math.exp(-x));
export function scoreModel(m,features) {
  const x=m.features.map(f=>features[f]);
  if (m.family==="LR" || m.family==="RBF SVM") {
    const z=x.map((v,i)=>(v-m.mean[i])/m.scale[i]);
    if(m.family==="LR") return sigmoid(m.coef.reduce((a,v,i)=>a+v*z[i],m.bias));
    return sigmoid(m.sv.reduce((total,sv,i)=>{
      const d=sv.reduce((a,v,j)=>a+(v-z[j])**2,0);
      return total+m.dual[i]*Math.exp(-m.gamma*d);
    },m.bias));
  }
  const sum=m.trees.reduce((total,tree)=>{
    let i=0;
    while(tree.left[i]!==-1) {
      const v=x[tree.feature[i]];
      i=(m.family==="RF"?Math.fround(v):v)<=tree.cut[i]?tree.left[i]:tree.right[i];
    }
    return total+tree.value[i];
  },0);
  return m.family==="RF"?sum/m.trees.length:sigmoid(m.bias+sum);
}
function features(samples,pre){
  const e=samples.map(s=>s.e),m=samples.map(s=>s.m),lo=Math.min(...e),hi=Math.max(...e);
  return {ear_last:e[e.length-1], ear_min:lo, ear_mean:e.reduce((a,b)=>a+b,0)/e.length,
    ear_change:e[e.length-1]-e[0],ear_drop:pre-lo,ear_range:hi-lo,mar_change:m[m.length-1]-m[0],mar_onset:m[0]};
}
export class EventMonitor {
  constructor(model=null){
    if(model!==null) validate(model);
    this.model=model;
    this.last=null;
    this.clear();
  }
  // armed: the previous usable frame was open, so the next closing frame is an observed onset.
  // unseen: a closure was already under way at the first usable frame; its onset is unknown,
  // so it is waited out and never timed or scored (same rule as study/events.py scan_clip).
  clear(){this.history=[];this.active=null;this.armed=false;this.unseen=false;}
  step(t,e,m){
    if(!Number.isFinite(t)) throw new Error("Invalid frame timestamp.");
    if(this.last!==null&&(t<=this.last||t-this.last>.150001))this.clear();
    this.last=t;
    const state={phase:"waiting",elapsed:0,score:null,decision:"observing",horizon:this.model?this.model.horizon_ticks/10:null};
    if(!Number.isFinite(e)||!Number.isFinite(m)||e<.05||e>.8||m<.05||m>3){
      this.clear();return {...state,phase:"tracking lost"};
    }
    if(e>=.23){this.active=null;this.unseen=false;}
    if(!this.active && !this.unseen && e<=.20){
      if(this.armed){
        const sorted=[...this.history].sort((a,b)=>a-b);
        const mid=Math.floor(sorted.length/2);
        const pre=sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;
        this.active={start:t,pre,samples:[],attempted:false,score:null};
      }else this.unseen=true;
    }
    if(this.active){
      const a=this.active;
      state.phase="closure";state.elapsed=t-a.start;
      if(!a.attempted && this.model){
        a.samples.push({t,e,m});
        if(state.elapsed+1e-8>=state.horizon){
          // For a delayed camera callback, take only observed values at or before each checkpoint.
          const prefix=[];let j=0;
          for(let k=0;k<=this.model.horizon_ticks;k++){
            const need=a.start+k/10;
            while(j+1<a.samples.length && a.samples[j+1].t<=need+1e-8)j++;
            if(need-a.samples[j].t>.15)break;
            prefix.push(a.samples[j]);
          }
          if(prefix.length===this.model.horizon_ticks+1)a.score=scoreModel(this.model,features(prefix,a.pre));
          a.attempted=true;a.samples=[];
        }
      }
      state.score=a.score;
      if(a.score!==null && a.score>=this.model.threshold-1e-12)state.decision="flagged";
    }else{
      state.phase=this.unseen?"waiting":"open";
    }
    this.armed=!this.active&&!this.unseen;
    this.history.push(e);if(this.history.length>3)this.history.shift();
    return state;
  }
}

