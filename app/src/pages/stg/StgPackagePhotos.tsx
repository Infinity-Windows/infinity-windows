import { usePhotoPicker } from '../../lib/photo/usePhotoPicker';
import { savePartnerPhoto, loadPartnerPhoto, removePartnerPhoto } from '../../lib/stgWarehousePhotoDraft';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { signedInId } from '../../lib/signedIn';
import { shrinkPhotoFile } from '../../lib/photo/stampPhoto';
import { imageFilesOnly } from '../../lib/photo/imageFiles';
import { formatApiError } from '../../lib/errors';
import { QueryError } from '../../components/ui/States';
export function StgPackagePhotos({project,packageId,canUpload}:{project:string;packageId:string;canUpload:boolean}) {
  const [draftSaved,setDraftSaved]=useState(false);
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const [pending,setPending]=useState<{file:File;path:string}|null>(null);
  useEffect(()=>{
    let active=true;const actor=signedInId();
    if(actor)void loadPartnerPhoto(actor,packageId).then(draft=>{if(active&&draft){setPending(draft);setDraftSaved(true);}}).catch(e=>{if(active)setError(formatApiError(e));});
    return()=>{active=false;};
  },[packageId]);
  const photos=useQuery({queryKey:['stgWarehousePhotos',project,packageId],queryFn:async()=>{
    const {data,error}=await supabase.rpc('stg_warehouse_photos',{p_project:project,p_package:packageId});if(error)throw error;
    return Promise.all((data as {id:string;storage_path:string}[]??[]).map(async photo=>{
      const {data,error}=await supabase.storage.from('install-media').createSignedUrl(photo.storage_path.slice(14),60);
      if(error)throw error;return {id:photo.id,url:data.signedUrl};
    }));
  },staleTime:30_000});
  async function upload(item:{file:File;path:string}) {
    setBusy(true);setError('');setPending(item);
    try {
      const actor=signedInId();
      if(!actor||item.path.split('/')[3]!==actor)throw new Error('Your session changed. Reopen this package.');
      await savePartnerPhoto({...item,actor,packageId});setDraftSaved(true);
      const {error}=await supabase.storage.from('install-media').upload(item.path,item.file,{contentType:item.file.type,upsert:false});
      // A lost upload response can leave the object present. The attach RPC
      // still checks its path, package, login and current grants on every retry.
      if(error && error.statusCode!=='409')throw error;
      const {error:attached}=await supabase.rpc('stg_attach_warehouse_photo',{p_project:project,p_package:packageId,p_path:item.path});
      if(attached)throw attached;await removePartnerPhoto(item.path);setPending(null);await photos.refetch();
    }catch(e){setError(formatApiError(e));}finally{setBusy(false);}
  }
  const picker=usePhotoPicker({camera:true,multiple:false,onFiles:async files=>{
    const file=files[0];const actor=signedInId();
    if(!actor||imageFilesOnly([file]).length===0){setError('Choose an image while signed in.');return;}
    if(file.size>20*1024*1024){setError('Choose a photo smaller than 20 MB.');return;}
    try{await upload({file:await shrinkPhotoFile(file),path:`packages/${packageId}/stg/${actor}/${crypto.randomUUID()}.jpg`});}catch(err){setError(formatApiError(err));}
  }});
  return <section className="detail-card"><h3>Selected package photos</h3>
    {photos.isError&&<QueryError error={photos.error} onRetry={()=>photos.refetch()}/>}
    <div style={{display:'flex',flexWrap:'wrap',gap:8}}>{photos.data?.map(p=><a href={p.url} key={p.id} target="_blank" rel="noreferrer"><img src={p.url} alt="Package condition" style={{width:120,height:120,objectFit:'cover',borderRadius:8}}/></a>)}</div>
    {photos.data?.length===0&&<p className="muted">No photos on this package.</p>}
    {canUpload&&<div className="stg-actions"><button type="button" disabled={busy||pending!==null} onClick={picker.openCamera}>Take photo</button><button type="button" disabled={busy||pending!==null} onClick={picker.openLibrary}>Upload photo</button>{picker.inputs}</div>}
    {error&&<p role="alert">{error}</p>}
    {pending&&<><p className="muted">{draftSaved ? "Photo not confirmed. Saved on this device; return to this package to retry when connected." : "Photo not confirmed or saved on this device. Keep this page open and retry."}</p><button type="button" disabled={busy} onClick={()=>void upload(pending)}>Retry photo</button></>}
  </section>;
}
