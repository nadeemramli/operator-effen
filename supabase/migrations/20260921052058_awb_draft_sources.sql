-- Private source PDFs for the explicitly authorized team testing workspace.
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('awb-draft-sources','awb-draft-sources',false,20971520,array['application/pdf']);
create policy "testers upload own AWB sources" on storage.objects
for insert to authenticated with check (
  bucket_id='awb-draft-sources' and (storage.foldername(name))[1]=(select auth.uid())::text
  and (select auth.jwt())->'app_metadata'->>'ui_draft_access'='true'
);
create policy "testers read own AWB sources" on storage.objects
for select to authenticated using (
  bucket_id='awb-draft-sources' and (storage.foldername(name))[1]=(select auth.uid())::text
  and (select auth.jwt())->'app_metadata'->>'ui_draft_access'='true'
);
