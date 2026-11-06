/** Backport GIF support from yukkcat/chatgpt2api 3.2.4 to pinned basketikun source.
 * Strict anchors ensure an upstream snapshot mismatch fails rather than silently
 * running partially patched source. No official OpenAI API key or paid transport.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PATCH_VERSION='pool-gif-v2';
const patchedFiles=[
  'utils/helper.py',
  'services/protocol/conversation.py',
  'services/protocol/openai_v1_image_generations.py',
  'api/ai.py',
  'services/image_storage_service.py',
  'services/image_service.py',
  'services/openai_backend_api.py',
  'services/protocol/openai_v1_models.py'
];
function swap(s,needle,replacement,file){
  const at=s.indexOf(needle);
  if(at===-1||s.indexOf(needle,at+needle.length)!==-1)throw Error('GIF backport source anchor mismatch: '+file+' '+needle.slice(0,90));
  return s.slice(0,at)+replacement+s.slice(at+needle.length);
}
function patch(file,s){
  const change=(a,b)=>{s=swap(s,a,b,file)};
  if(file==='utils/helper.py'){
    change('BASE_IMAGE_MODELS = {"gpt-image-2", "codex-gpt-image-2"}',
      'BASE_IMAGE_MODELS = {"gpt-image-2", "codex-gpt-image-2", "gpt-image-2.6", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst"}');
  }
  if(file==='services/protocol/openai_v1_models.py'){
    change('dynamic_models.add("gpt-image-2")','dynamic_models.update({"gpt-image-2", "gpt-image-2.6", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst"})');
  }
  if(file==='api/ai.py'){
    change('    history_disabled: bool = True\n    stream: bool | None = None\n',
      '    history_disabled: bool = True\n    stream: bool | None = None\n    output_format: str | None = None\n    frame_count: int | None = None\n    frame_duration_ms: int | None = None\n');
  }
  if(file==='services/protocol/openai_v1_image_generations.py'){
    change('    base_url = str(body.get("base_url") or "") or None',
      '    output_format = body.get("output_format")\n    frame_count = body.get("frame_count")\n    frame_duration_ms = body.get("frame_duration_ms")\n    if output_format == "gif":\n        if model not in {"gpt-image-2.6", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst"}:\n            from fastapi import HTTPException\n            raise HTTPException(status_code=400, detail={"error":"GIF requires a GPT Image 2.6 model"})\n        if body.get("stream"):\n            from fastapi import HTTPException\n            raise HTTPException(status_code=400, detail={"error":"GIF streaming is not supported"})\n    elif output_format not in (None, "png", "webp", "jpeg", "jpg"):\n        from fastapi import HTTPException\n        raise HTTPException(status_code=400, detail={"error":"unsupported image output_format"})\n    base_url = str(body.get("base_url") or "") or None');
    change('        response_format=response_format,\n        base_url=base_url,',
      '        response_format=response_format,\n        output_format=output_format,\n        frame_count=frame_count,\n        frame_duration_ms=frame_duration_ms,\n        base_url=base_url,');
  }
  if(file==='services/protocol/conversation.py'){
    change('    response_format: str = "b64_json"\n    base_url: str | None = None',
      '    response_format: str = "b64_json"\n    output_format: str | None = None\n    frame_count: int | None = None\n    frame_duration_ms: int | None = None\n    base_url: str | None = None');
    change('def build_image_prompt(prompt: str, size: str | None, quality: str = "auto") -> str:',
      'def build_image_prompt(prompt: str, size: str | None, quality: str = "auto", output_format: str | None = None, frame_count: int | None = None, frame_duration_ms: int | None = None) -> str:');
    change('    if quality:\n        hints.append(f"输出图片质量为 {quality}。")\n    return f"{prompt.strip()}\\n\\n{\'\'.join(hints)}" if hints else prompt',
      '    if quality:\n        hints.append(f"输出图片质量为 {quality}。")\n    if output_format == "gif":\n        hints.append("生成格式为 gif 动图；输出真正的多帧动画，不要输出分镜拼图或静态帧。")\n        if frame_count is not None:\n            hints.append(f"frame_count: {frame_count}。")\n        if frame_duration_ms is not None:\n            hints.append(f"frame_duration_ms: {frame_duration_ms}。")\n    return f"{prompt.strip()}\\n\\n{\'\'.join(hints)}" if hints else prompt');
    change('    quality: str = "auto",\n    thinking_effort: str = "",\n) -> Iterator[dict[str, Any]]:',
      '    quality: str = "auto",\n    output_format: str | None = None,\n    frame_count: int | None = None,\n    frame_duration_ms: int | None = None,\n    thinking_effort: str = "",\n) -> Iterator[dict[str, Any]]:');
    change('build_image_prompt(prompt, size, quality)) if image_model else prompt',
      'build_image_prompt(prompt, size, quality, output_format, frame_count, frame_duration_ms)) if image_model else prompt');
    change('            quality=request.quality,\n    ):\n        last = event',
      '            quality=request.quality,\n            output_format=request.output_format,\n            frame_count=request.frame_count,\n            frame_duration_ms=request.frame_duration_ms,\n    ):\n        last = event');
    change('def format_image_result(\n    items: list[dict[str, Any]],\n    prompt: str,\n    response_format: str,\n    base_url: str | None = None,\n    created: int | None = None,\n    message: str = "",',
      'def format_image_result(\n    items: list[dict[str, Any]],\n    prompt: str,\n    response_format: str,\n    base_url: str | None = None,\n    created: int | None = None,\n    message: str = "",\n    output_format: str | None = None,');
    change('        revised_prompt = str(item.get("revised_prompt") or prompt).strip() or prompt\n        if response_format == "b64_json":',
      '        revised_prompt = str(item.get("revised_prompt") or prompt).strip() or prompt\n        if output_format == "gif" and not base64.b64decode(b64_json).startswith((b"GIF87a", b"GIF89a")):\n            raise ImageGenerationError("upstream did not return an animated GIF", status_code=502)\n        if response_format == "b64_json":');
    // All image result paths must get request output format; guarded count.
    const before=s;
    s=s.replace(/(request\.base_url,\n[ \t]*int\(time\.time\(\)\),\n)([ \t]*)(\)\["data"\])/g,
      '$1$2output_format=request.output_format,\n$2$3');
    if((before.match(/request\.base_url,\n[ \t]*int\(time\.time\(\)\),\n[ \t]*\)\["data"\]/g)||[]).length!==4)throw Error('GIF backport expected four image format call sites');
    change('        quality=request.quality,\n    )))\n    if not images:',
      '        quality=request.quality,\n        output_format=request.output_format,\n        frame_count=request.frame_count,\n        frame_duration_ms=request.frame_duration_ms,\n    )))\n    if not images:');
  }
  if(file==='services/openai_backend_api.py'){
    change('            quality: str = "auto",\n    ) -> Iterator[Dict[str, Any]]:',
      '            quality: str = "auto",\n            output_format: str | None = None,\n            frame_count: int | None = None,\n            frame_duration_ms: int | None = None,\n    ) -> Iterator[Dict[str, Any]]:');
    change('                "output_format": "png",\n            }],',
      '                "output_format": output_format or "png",\n                **({"frame_count": frame_count} if output_format == "gif" and frame_count is not None else {}),\n                **({"frame_duration_ms": frame_duration_ms} if output_format == "gif" and frame_duration_ms is not None else {}),\n            }],');
    change('        if base_model == "gpt-image-2":',
      '        if base_model == "gpt-image-2":');
    change('        elif base_model == CODEX_IMAGE_MODEL:',
      '        elif base_model in {"gpt-image-2.6", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst"}:\n            return "auto", ""\n        elif base_model == CODEX_IMAGE_MODEL:');
  }
  if(file==='services/image_storage_service.py'){
    change('IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}',
      'IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}');
    change('        filename = f"{int(time.time())}_{file_hash}.png"',
      '        extension = ".gif" if image_data.startswith((b"GIF87a", b"GIF89a")) else ".png"\n        filename = f"{int(time.time())}_{file_hash}{extension}"');
  }
  if(file==='services/image_service.py'){
    const old='media_type="image/png",';
    if(s.split(old).length-1!==2)throw Error('expected two image media type branches');
    s=s.replaceAll(old,'media_type="image/gif" if str(relative_path).lower().endswith(".gif") else "image/png",');
  }
  return s;
}
export function installPoolGifBackendPatch(sourceRoot) {
  const root=path.resolve(sourceRoot);
  const marker=path.join(root,'.dsh-pool-gif-patch');
  const data=[];
  for(const rel of patchedFiles){
    const file=path.join(root,rel);
    const content=fs.readFileSync(file,'utf8');
    if(content.startsWith('# DSH_POOL_GIF_PATCH '+PATCH_VERSION+'\n')){
      data.push([file,content]);continue;
    }
    const patched='# DSH_POOL_GIF_PATCH '+PATCH_VERSION+'\n'+patch(rel,content);
    data.push([file,patched]);
  }
  // Transform and validate all sources before replacing any pinned files.
  for(const [file,content] of data){
    const tmp=file+'.dsh-gif-tmp';
    fs.writeFileSync(tmp,content,{mode:0o600});
    fs.renameSync(tmp,file);
  }
  fs.writeFileSync(marker,PATCH_VERSION+'\n',{mode:0o600});
  return {version:PATCH_VERSION,files:data.length};
}
