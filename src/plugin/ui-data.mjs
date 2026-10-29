import {useEffect,useState} from 'react';

/** Use authenticated routes so native Decisions carry the actual viewer identity. */
export function useGraphData(companyId,issueId,runId) {
  const [result,setResult]=useState({data:null,loading:Boolean(companyId),error:null});
  const [revision,setRevision]=useState(0);
  useEffect(()=>{
    if(!companyId){setResult({data:null,loading:false,error:null});return;}
    const controller=new AbortController();
    setResult({data:null,loading:true,error:null});
    const query=new URLSearchParams({companyId,...(issueId?{issueId}:{}),...(runId?{runId}:{})});
    fetch(`/api/plugins/pohlee.polyforge-graph/api/graph?${query}`,{credentials:'same-origin',signal:controller.signal})
      .then(async response=>{const body=await response.json();if(!response.ok)throw new Error(body.error??`Graph data unavailable (${response.status})`);return body;})
      .then(data=>setResult({data,loading:false,error:null}))
      .catch(error=>{if(error.name!=='AbortError')setResult({data:null,loading:false,error:error.message});});
    return()=>controller.abort();
  },[companyId,issueId,runId,revision]);
  return {...result,refresh:()=>setRevision(value=>value+1)};
}
