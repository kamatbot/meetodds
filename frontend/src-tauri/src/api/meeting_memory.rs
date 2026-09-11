// Included in meeting_intelligence.rs: local recall and preparation, independent of AI generation.
fn memory_vector(text: &str) -> Vec<(usize, f32)> {
    let tokens = terms(text); let mut weights: HashMap<usize, f32> = HashMap::new();
    for token in &tokens { let hash = u64::from_str_radix(&stable_hash(token), 16).unwrap_or_default(); *weights.entry((hash as usize) % MEMORY_VECTOR_DIM).or_insert(0.0) += 1.0; }
    for window in tokens.windows(2) { let hash = u64::from_str_radix(&stable_hash(&format!("{} {}", window[0], window[1])), 16).unwrap_or_default(); *weights.entry((hash as usize) % MEMORY_VECTOR_DIM).or_insert(0.0) += 0.55; }
    let norm = weights.values().map(|v| (*v as f64) * (*v as f64)).sum::<f64>().sqrt() as f32;
    let mut vector: Vec<_> = weights.into_iter().map(|(i,v)| (i, if norm > 0.0 { v / norm } else { v })).collect(); vector.sort_by_key(|(i,_)| *i); vector
}
fn cosine(left: &[(usize,f32)], right: &[(usize,f32)]) -> f64 {
    let (mut i, mut j, mut score) = (0,0,0.0);
    while i < left.len() && j < right.len() { match left[i].0.cmp(&right[j].0) { Ordering::Equal => { score += (left[i].1 as f64)*(right[j].1 as f64); i+=1;j+=1; }, Ordering::Less => i+=1, Ordering::Greater => j+=1 } }
    score
}
fn token_overlap(query: &str, content: &str) -> f64 { let q=term_set(query); let c=term_set(content); if q.is_empty() || c.is_empty() { 0.0 } else { q.intersection(&c).count() as f64 / q.len() as f64 } }
async fn build_source_documents(pool: &SqlitePool, meeting_id: &str) -> Result<(Vec<SourceDocument>,MeetingContext),String> {
    let context = load_context(pool, meeting_id).await?; let mut documents = Vec::new();
    for turn in fetch_transcripts(pool, meeting_id).await? { documents.push(SourceDocument { kind:"transcript".to_string(), source_id:turn.id.clone(), content:turn.text, transcript_id:Some(turn.id), audio_start_time:turn.start, audio_end_time:turn.end, speaker_label:turn.speaker_label }); }
    if let Some(notes) = sqlx::query_scalar::<_,Option<String>>("SELECT notes_markdown FROM meetings WHERE id = ?").bind(meeting_id).fetch_optional(pool).await.map_err(db_error)?.flatten().and_then(|n|clean_optional(Some(n))) {
        documents.push(SourceDocument { kind:"notes".to_string(), source_id:"meeting-notes".to_string(), content:notes, transcript_id:None, audio_start_time:None, audio_end_time:None, speaker_label:None });
    }
    if let Some(notes) = sqlx::query_scalar::<_,String>("SELECT content FROM meeting_manual_notes WHERE meeting_id = ?").bind(meeting_id).fetch_optional(pool).await.map_err(db_error)?.and_then(|n|clean_optional(Some(n))) {
        documents.push(SourceDocument { kind:"manual_notes".to_string(), source_id:"manual-notes".to_string(), content:notes, transcript_id:None, audio_start_time:None, audio_end_time:None, speaker_label:None });
    }
    let context_text = [context.project.as_ref().map(|v|format!("Project: {v}.")),context.client.as_ref().map(|v|format!("Client: {v}.")),(!context.participants.is_empty()).then(||format!("Participants: {}.",context.participants.join(", "))),context.agenda.as_ref().map(|v|format!("Agenda: {v}"))].into_iter().flatten().collect::<Vec<_>>().join(" ");
    if !context_text.is_empty() { documents.push(SourceDocument { kind:"context".to_string(), source_id:"meeting-context".to_string(), content:context_text, transcript_id:None, audio_start_time:None, audio_end_time:None, speaker_label:None }); }
    let facts = sqlx::query("SELECT f.id, f.kind, f.text, e.transcript_id, e.audio_start_time, e.audio_end_time, e.speaker_label FROM meeting_facts f LEFT JOIN meeting_evidence e ON e.id = (SELECT e1.id FROM meeting_evidence e1 WHERE e1.fact_id = f.id ORDER BY e1.created_at ASC LIMIT 1) WHERE f.meeting_id = ? AND f.state <> 'dismissed' AND f.confirmed = 1")
        .bind(meeting_id).fetch_all(pool).await.map_err(db_error)?;
    for row in facts { documents.push(SourceDocument { kind:row.get("kind"),source_id:row.get("id"),content:row.get("text"),transcript_id:row.try_get("transcript_id").unwrap_or(None),audio_start_time:row.try_get("audio_start_time").unwrap_or(None),audio_end_time:row.try_get("audio_end_time").unwrap_or(None),speaker_label:row.try_get("speaker_label").unwrap_or(None) }); }
    let actions = sqlx::query("SELECT a.id, a.text, a.owner, a.due_at, a.due_text, e.transcript_id, e.audio_start_time, e.audio_end_time, e.speaker_label FROM meeting_actions a LEFT JOIN meeting_evidence e ON e.id = (SELECT e1.id FROM meeting_evidence e1 WHERE e1.action_id = a.id ORDER BY e1.created_at ASC LIMIT 1) WHERE a.meeting_id = ? AND a.status <> 'dismissed' AND a.confirmed = 1")
        .bind(meeting_id).fetch_all(pool).await.map_err(db_error)?;
    for row in actions {
        let mut content:String = row.get("text");
        if let Some(owner) = row.try_get::<Option<String>,_>("owner").unwrap_or(None) { content.push_str(&format!(" Owner: {owner}.")); }
        if let Some(due) = row.try_get::<Option<String>,_>("due_at").unwrap_or(None).or(row.try_get::<Option<String>,_>("due_text").unwrap_or(None)) { content.push_str(&format!(" Due: {due}.")); }
        documents.push(SourceDocument { kind:"action".to_string(),source_id:row.get("id"),content,transcript_id:row.try_get("transcript_id").unwrap_or(None),audio_start_time:row.try_get("audio_start_time").unwrap_or(None),audio_end_time:row.try_get("audio_end_time").unwrap_or(None),speaker_label:row.try_get("speaker_label").unwrap_or(None) });
    }
    Ok((documents,context))
}
async fn index_meeting_memory(pool: &SqlitePool,meeting_id:&str)->Result<(),String> {
    let (documents,context)=build_source_documents(pool,meeting_id).await?; if documents.is_empty(){return Ok(());}
    let source=documents.iter().map(|d|format!("{}:{}:{}",d.kind,d.source_id,d.content)).collect::<Vec<_>>().join("\u{1f}");
    let hash=stable_hash(&format!("vector-v{MEMORY_VECTOR_VERSION}:{source}"));
    let previous:Option<String>=sqlx::query_scalar("SELECT source_hash FROM meeting_memory_state WHERE meeting_id = ?").bind(meeting_id).fetch_optional(pool).await.map_err(db_error)?;
    if previous.as_deref()==Some(hash.as_str()){return Ok(());}
    let mut tx=pool.begin().await.map_err(db_error)?;
    sqlx::query("DELETE FROM meeting_memory_documents WHERE meeting_id = ?").bind(meeting_id).execute(&mut *tx).await.map_err(db_error)?;
    for d in documents {
        let vector=serde_json::to_string(&memory_vector(&d.content)).map_err(|e|e.to_string())?;
        sqlx::query("INSERT INTO meeting_memory_documents (id, meeting_id, kind, source_id, content, vector_json, project, client, transcript_id, audio_start_time, audio_end_time, speaker_label, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)")
            .bind(Uuid::new_v4().to_string()).bind(meeting_id).bind(d.kind).bind(d.source_id).bind(d.content).bind(vector).bind(&context.project).bind(&context.client).bind(d.transcript_id).bind(d.audio_start_time).bind(d.audio_end_time).bind(d.speaker_label).execute(&mut *tx).await.map_err(db_error)?;
    }
    sqlx::query("INSERT INTO meeting_memory_state (meeting_id, source_hash, indexed_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(meeting_id) DO UPDATE SET source_hash = excluded.source_hash, indexed_at = CURRENT_TIMESTAMP")
        .bind(meeting_id).bind(hash).execute(&mut *tx).await.map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;Ok(())
}
async fn scope_value_from_meeting(pool:&SqlitePool,meeting_id:Option<&str>,field:&str)->Result<Option<String>,String>{
    let Some(id)=meeting_id else{return Ok(None);};let c=load_context(pool,id).await?;Ok(match field{"project"=>c.project,"client"=>c.client,_=>None})
}
async fn scoped_meeting_ids(pool:&SqlitePool,r:&MemorySearchRequest)->Result<(Vec<String>,String),String>{
    match r.scope.as_str(){
        "meeting"=>{let id=r.meeting_id.as_deref().ok_or_else(||"Meeting scope requires meetingId".to_string())?;ensure_meeting_exists(pool,id).await?;Ok((vec![id.to_string()],"This meeting".to_string()))},
        "project"|"client"=>{
            let value=clean_optional(if r.scope=="project"{r.project.clone()}else{r.client.clone()}).or(scope_value_from_meeting(pool,r.meeting_id.as_deref(),&r.scope).await?).ok_or_else(||format!("Add a {} to the meeting before using recall",r.scope))?;
            let sql=if r.scope=="project"{"SELECT c.meeting_id FROM meeting_contexts c JOIN meetings m ON m.id = c.meeting_id WHERE m.deleted_at IS NULL AND LOWER(c.project) = LOWER(?) ORDER BY m.created_at DESC"}else{"SELECT c.meeting_id FROM meeting_contexts c JOIN meetings m ON m.id = c.meeting_id WHERE m.deleted_at IS NULL AND LOWER(c.client) = LOWER(?) ORDER BY m.created_at DESC"};
            let ids=sqlx::query_scalar(sql).bind(&value).fetch_all(pool).await.map_err(db_error)?;
            Ok((ids,format!("{} · {value}",if r.scope=="project"{"Project"}else{"Client"})))
        },
        "all"=>Ok((sqlx::query_scalar("SELECT id FROM meetings WHERE deleted_at IS NULL ORDER BY created_at DESC").fetch_all(pool).await.map_err(db_error)?,"All meetings".to_string())),
        _=>Err("Recall scope must be meeting, project, client, or all".to_string())
    }
}
fn snippet_for_query(content:&str,query:&str)->String{
    const MAX_CHARS:usize=320;
    let chars:Vec<char>=content.chars().collect();if chars.len()<=MAX_CHARS{return content.trim().to_string();}
    let q=term_set(query);let(mut best_start,mut best_score,mut start)=(0,0.0,0);
    while start<chars.len(){let end=(start+MAX_CHARS).min(chars.len());let c: String=chars[start..end].iter().collect();let terms=term_set(&c);let score=if q.is_empty(){0.0}else{q.intersection(&terms).count() as f64/q.len() as f64};if score>best_score{best_score=score;best_start=start;}if end==chars.len(){break;}start+=MAX_CHARS/4;}
    let end=(best_start+MAX_CHARS).min(chars.len());let mut snippet:String=chars[best_start..end].iter().collect();if best_start>0{snippet.insert_str(0,"…");}if end<chars.len(){snippet.push('…');}snippet.trim().to_string()
}
#[tauri::command]
pub async fn api_search_meeting_memory(state:State<'_,AppState>,request:MemorySearchRequest)->Result<MemorySearchResponse,String>{
    let pool=state.db_manager.pool();let query=request.query.trim();if query.len()<2{return Err("Ask a more specific question".to_string());}
    let(ids,scope_label)=scoped_meeting_ids(pool,&request).await?;if ids.is_empty(){return Ok(MemorySearchResponse{answer:"No meetings are linked to this scope yet.".to_string(),scope_label,hits:Vec::new()});}
    for id in &ids{if let Err(e)=index_meeting_memory(pool,id).await{log::warn!("Could not index meeting {} for local recall: {}",id,e);}}
    let allowed:HashSet<&str>=ids.iter().map(String::as_str).collect();let vector=memory_vector(query);
    let rows=sqlx::query("SELECT d.meeting_id, m.title AS meeting_title, d.kind, d.source_id, d.content, d.vector_json, d.transcript_id, d.audio_start_time, d.audio_end_time, d.speaker_label, d.project, d.client FROM meeting_memory_documents d JOIN meetings m ON m.id = d.meeting_id WHERE m.deleted_at IS NULL").fetch_all(pool).await.map_err(db_error)?;
    let mut hits=Vec::new();
    for row in rows{
        let id:String=row.get("meeting_id");if !allowed.contains(id.as_str()){continue;}
        let other=serde_json::from_str::<Vec<(usize,f32)>>(&row.get::<String,_>("vector_json")).unwrap_or_default();let content:String=row.get("content");let score=cosine(&vector,&other).max(0.0)*0.72+token_overlap(query,&content)*0.28;if score<=0.01{continue;}
        hits.push(MemoryHit{meeting_id:id,meeting_title:row.get("meeting_title"),kind:row.get("kind"),source_id:row.get("source_id"),snippet:snippet_for_query(&content,query),score,transcript_id:row.try_get("transcript_id").unwrap_or(None),audio_start_time:row.try_get("audio_start_time").unwrap_or(None),audio_end_time:row.try_get("audio_end_time").unwrap_or(None),speaker_label:row.try_get("speaker_label").unwrap_or(None),project:row.try_get("project").unwrap_or(None),client:row.try_get("client").unwrap_or(None)});
    }
    hits.sort_by(|a,b|b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal));let mut seen=HashSet::new();
    hits.retain(|h|seen.insert(match h.transcript_id.as_deref(){Some(t)=>format!("{}:transcript:{t}",h.meeting_id),None=>format!("{}:{}:{}",h.meeting_id,h.kind,h.source_id)}));hits.truncate(request.limit.unwrap_or(12).clamp(1,30));
    let answer=if hits.is_empty(){"I could not find supporting meeting evidence for that question in this scope.".to_string()}else{let mut answer="Strongest matching meeting evidence:\n".to_string();for h in hits.iter().take(4){answer.push_str(&format!("\n- {} — {}",h.snippet.replace('\n'," "),h.meeting_title));}answer};
    Ok(MemorySearchResponse{answer,scope_label,hits})
}
async fn preparation_fact_rows(pool:&SqlitePool,ids:&HashSet<String>,kind:&str,limit:usize)->Result<Vec<PreparationItem>,String>{
    let rows=sqlx::query("SELECT f.id, f.meeting_id, f.text, f.confirmed, m.title AS meeting_title FROM meeting_facts f JOIN meetings m ON m.id = f.meeting_id WHERE f.kind = ? AND f.state <> 'dismissed' AND f.confirmed = 1 AND m.deleted_at IS NULL ORDER BY f.confirmed DESC, f.confidence DESC, m.created_at DESC").bind(kind).fetch_all(pool).await.map_err(db_error)?;
    let mut result=Vec::new();for row in rows{let id:String=row.get("meeting_id");if !ids.contains(&id){continue;}let fact:String=row.get("id");result.push(PreparationItem{meeting_id:id,meeting_title:row.get("meeting_title"),text:row.get("text"),confirmed:true,evidence:load_evidence_for(pool,Some(&fact),None).await?.into_iter().next()});if result.len()>=limit{break;}}Ok(result)
}
async fn preparation_action_rows(pool:&SqlitePool,ids:&HashSet<String>,limit:usize)->Result<Vec<PreparationItem>,String>{
    let rows=sqlx::query("SELECT a.id, a.meeting_id, a.text, a.confirmed, m.title AS meeting_title FROM meeting_actions a JOIN meetings m ON m.id = a.meeting_id WHERE a.status = 'open' AND a.confirmed = 1 AND m.deleted_at IS NULL ORDER BY a.confirmed DESC, CASE WHEN a.due_at IS NULL THEN 1 ELSE 0 END, a.due_at ASC, m.created_at DESC").fetch_all(pool).await.map_err(db_error)?;
    let mut result=Vec::new();for row in rows{let id:String=row.get("meeting_id");if !ids.contains(&id){continue;}let action:String=row.get("id");result.push(PreparationItem{meeting_id:id,meeting_title:row.get("meeting_title"),text:row.get("text"),confirmed:true,evidence:load_evidence_for(pool,None,Some(&action)).await?.into_iter().next()});if result.len()>=limit{break;}}Ok(result)
}
#[tauri::command]
pub async fn api_get_meeting_preparation(state:State<'_,AppState>,meeting_id:String)->Result<MeetingPreparationResponse,String>{
    let pool=state.db_manager.pool();let id=meeting_id.trim();ensure_meeting_exists(pool,id).await?;let context=load_context(pool,id).await?;
    let(sql,value,scope_label)=if let Some(project)=context.project.clone(){("SELECT c.meeting_id FROM meeting_contexts c JOIN meetings m ON m.id = c.meeting_id WHERE m.deleted_at IS NULL AND c.meeting_id <> ? AND LOWER(c.project) = LOWER(?) ORDER BY m.created_at DESC LIMIT 20",project.clone(),format!("Project · {project}"))}else if let Some(client)=context.client.clone(){("SELECT c.meeting_id FROM meeting_contexts c JOIN meetings m ON m.id = c.meeting_id WHERE m.deleted_at IS NULL AND c.meeting_id <> ? AND LOWER(c.client) = LOWER(?) ORDER BY m.created_at DESC LIMIT 20",client.clone(),format!("Client · {client}"))}else{return Ok(MeetingPreparationResponse{context,scope_label:"Add a project or client to link recurring meetings.".to_string(),prior_decisions:Vec::new(),open_actions:Vec::new(),open_questions:Vec::new()});};
    let prior:Vec<String>=sqlx::query_scalar(sql).bind(id).bind(value).fetch_all(pool).await.map_err(db_error)?;
    // This refresh is now completed-summary-only, including a valid empty result.
    for id in &prior{refresh_meeting_intelligence(pool,id).await?;}
    let ids:HashSet<String>=prior.into_iter().collect();
    Ok(MeetingPreparationResponse{context,scope_label,prior_decisions:preparation_fact_rows(pool,&ids,"decision",8).await?,open_actions:preparation_action_rows(pool,&ids,10).await?,open_questions:preparation_fact_rows(pool,&ids,"open_question",8).await?})
}
