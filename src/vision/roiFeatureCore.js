/**
 * Pure ROI feature extraction and comparison.
 * Kept independent from DOM/canvas so the recognizer can be adversarially tested in Node.
 */
export function rectifyPatch(frameValues, frameWidth, frameHeight, centerX, centerY, roiWidth, roiHeight, cos, sin, size = 64) {
  if (!frameValues || frameValues.length < frameWidth * frameHeight ||
      frameWidth < 2 || frameHeight < 2 || roiWidth <= 0 || roiHeight <= 0) return null;
  const output = new Float32Array(size * size);
  for (let py = 0; py < size; py++) {
    const localY = ((py + 0.5) / size - 0.5) * roiHeight;
    for (let px = 0; px < size; px++) {
      const localX = ((px + 0.5) / size - 0.5) * roiWidth;
      const sx = Math.round(centerX + cos * localX - sin * localY);
      const sy = Math.round(centerY + sin * localX + cos * localY);
      if (sx < 0 || sy < 0 || sx >= frameWidth || sy >= frameHeight) return null;
      const value = frameValues[sy * frameWidth + sx];
      if (!Number.isFinite(value)) return null;
      output[py * size + px] = value;
    }
  }
  return output;
}

export function describePatch(values, size = 64, polarity = 'contrast') {
  if (!values || values.length !== size * size) throw new Error('Invalid ROI patch dimensions');
  const border = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (x < 5 || y < 5 || x >= size - 5 || y >= size - 5) border.push(values[y * size + x]);
  }
  const sorted = [...border].sort((a,b)=>a-b);
  const median = sorted[Math.floor(sorted.length/2)] ?? 0;
  const deviations = border.map(v=>Math.abs(v-median)).sort((a,b)=>a-b);
  const mad = deviations[Math.floor(deviations.length/2)] ?? 0;
  const threshold = Math.max(12, mad * 2.8);
  const mask = new Uint8Array(size*size);
  for(let y=2;y<size-2;y++) for(let x=2;x<size-2;x++) {
    const delta=values[y*size+x]-median;
    const contrast=polarity==='bright_on_dark'?delta:polarity==='dark_on_bright'?-delta:Math.abs(delta);
    if(contrast>=threshold) mask[y*size+x]=1;
  }
  const visited=new Uint8Array(mask.length), queue=new Int32Array(mask.length);
  let largest=null,largestPixels=null;
  for(let seed=0;seed<mask.length;seed++) {
    if(!mask[seed]||visited[seed]) continue;
    let head=0,tail=0,minX=size,minY=size,maxX=-1,maxY=-1,sumX=0,sumY=0,sumContrast=0,area=0,perimeter=0;
    queue[tail++]=seed; visited[seed]=1;
    while(head<tail) {
      const index=queue[head++],x=index%size,y=Math.floor(index/size);
      area++;sumX+=x;sumY+=y;sumContrast+=Math.abs(values[index]-median);minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);
      for(const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nx=x+dx,ny=y+dy;
        if(nx<0||ny<0||nx>=size||ny>=size||!mask[ny*size+nx]) perimeter++;
      }
      for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) {
        if(!dx&&!dy) continue;
        const nx=x+dx,ny=y+dy;
        if(nx<0||ny<0||nx>=size||ny>=size) continue;
        const ni=ny*size+nx;
        if(mask[ni]&&!visited[ni]){visited[ni]=1;queue[tail++]=ni;}
      }
    }
    if(!largest||area>largest.area) { largest={area,minX,minY,maxX,maxY,sumX,sumY,sumContrast,perimeter}; largestPixels=queue.slice(0,tail); }
  }
  const areaRatio=largest?largest.area/(size*size):0;
  const contrastStrength=largest?largest.sumContrast/largest.area:0;
  const plausibleArea=areaRatio>=0.003&&areaRatio<=0.62;
  const present=Boolean(largest&&plausibleArea&&contrastStrength>=2);
  const bboxWidth=largest?largest.maxX-largest.minX+1:0;
  const bboxHeight=largest?largest.maxY-largest.minY+1:0;
  const circularity=largest&&largest.perimeter>0?Math.min(1,4*Math.PI*largest.area/(largest.perimeter*largest.perimeter)):0;
  const solidity=largest&&bboxWidth*bboxHeight>0?largest.area/(bboxWidth*bboxHeight):0;
  const hog=new Float32Array(128),cellEdges=new Float32Array(16),componentCells=new Float32Array(16);
  if(largestPixels) for(const index of largestPixels) {
    const x=index%size,y=Math.floor(index/size);
    const cx=Math.min(3,Math.floor(x/(size/4))),cy=Math.min(3,Math.floor(y/(size/4)));
    componentCells[cy*4+cx]++;
  }
  let totalEdge=0;
  for(let y=1;y<size-1;y++) for(let x=1;x<size-1;x++) {
    const gx=values[y*size+x+1]-values[y*size+x-1];
    const gy=values[(y+1)*size+x]-values[(y-1)*size+x];
    const magnitude=Math.hypot(gx,gy);
    if(magnitude<8) continue;
    const cx=Math.min(3,Math.floor(x/(size/4))),cy=Math.min(3,Math.floor(y/(size/4)));
    const angle=(Math.atan2(gy,gx)+Math.PI)%Math.PI;
    const bin=Math.min(7,Math.floor(angle/Math.PI*8));
    hog[(cy*4+cx)*8+bin]+=magnitude;
    cellEdges[cy*4+cx]+=magnitude;totalEdge+=magnitude;
  }
  const normalize=array=>{
    let norm=0;for(const value of array)norm+=value*value;norm=Math.sqrt(norm);
    if(norm>0)for(let i=0;i<array.length;i++)array[i]/=norm;
  };
  normalize(hog);normalize(cellEdges);normalize(componentCells);
  const presenceConfidence=present
    ?Math.min(1,0.55+Math.min(0.25,areaRatio*2)+Math.min(0.2,contrastStrength/100))
    :(areaRatio<0.003&&contrastStrength<8?0.82:0.35);
  return {
    present,presenceConfidence,areaRatio,contrastStrength,
    centroidX:largest?largest.sumX/largest.area/size:0.5,
    centroidY:largest?largest.sumY/largest.area/size:0.5,
    bboxWidth:bboxWidth/size,bboxHeight:bboxHeight/size,
    aspectRatio:bboxHeight>0?bboxWidth/bboxHeight:1,
    circularity,solidity,hog,cellEdges,componentCells,edgeDensity:totalEdge/(size*size*255)
  };
}
function cosineSimilarity(a,b){
  let dot=0,aa=0,bb=0;
  for(let i=0;i<Math.min(a.length,b.length);i++){dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];}
  if(aa<=1e-12||bb<=1e-12)return aa<=1e-12&&bb<=1e-12?1:0;
  return Math.max(0,Math.min(1,dot/Math.sqrt(aa*bb)));
}
function ratioSimilarity(a,b,sensitivity=0.5){
  if(a<=0||b<=0)return a===b?1:0;
  return Math.exp(-Math.abs(Math.log(a/b))*sensitivity);
}
export function compareDescriptors(a,b){
  if(!a||!b)return 0;
  if(a.present!==b.present)return 0.05;
  if(!a.present&&!b.present)return 0.98;
  const hog=cosineSimilarity(a.hog,b.hog),spatial=cosineSimilarity(a.cellEdges,b.cellEdges);
  const occupancy=cosineSimilarity(a.componentCells,b.componentCells);
  const size=ratioSimilarity(a.areaRatio,b.areaRatio,0.65);
  const aspect=ratioSimilarity(a.aspectRatio,b.aspectRatio,0.45);
  const circularity=1-Math.min(1,Math.abs(a.circularity-b.circularity));
  const solidity=1-Math.min(1,Math.abs(a.solidity-b.solidity));
  const position=Math.exp(-Math.hypot(a.centroidX-b.centroidX,a.centroidY-b.centroidY)*5);
  const contour=aspect*0.45+circularity*0.25+solidity*0.30;
  return Math.max(0,Math.min(1,hog*0.22+spatial*0.15+occupancy*0.25+size*0.15+contour*0.13+position*0.10));
}
