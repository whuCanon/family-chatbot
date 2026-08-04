import os
import time
import json
import glob
import uuid
import base64
import shutil
import requests
from flask import Flask, request, jsonify, send_from_directory, session, Response, stream_with_context
from dotenv import load_dotenv
from PIL import Image
import pillow_heif

# 注册 HEIF 格式支持，使 Pillow 能够打开 HEIC/HEIF 图片
pillow_heif.register_heif_opener()

load_dotenv()

app = Flask(__name__, static_folder='static')
app.secret_key = os.getenv("FLASK_SECRET_KEY", "complex_fixed_secret_key_for_persistence")
app.config['PERMANENT_SESSION_LIFETIME'] = 3600 * 24 * 30 
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 全局 API 请求最大限制 50MB

# --- Configuration ---
SITE_PASSWORD = os.getenv("SITE_PASSWORD", "lwtlwt123")

# Gemini Config
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_NATIVE_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent"

# Model Parameters
DEFAULT_SYSTEM_PROMPT = os.getenv("SYSTEM_PROMPT", "You are a helpful and friendly family AI assistant.")
try:
    MAX_OUTPUT_TOKENS = int(os.getenv("MAX_OUTPUT_TOKENS", "8192"))
except:
    MAX_OUTPUT_TOKENS = 8192

try:
    TEMPERATURE = float(os.getenv("TEMPERATURE", "1.0"))
except:
    TEMPERATURE = 1.0

IMAGE_CACHE_DIR = "logs/cache_images"
if not os.path.exists(IMAGE_CACHE_DIR):
    os.makedirs(IMAGE_CACHE_DIR)

# --- Security & Blacklist System ---
SECURITY_FILE = "logs/security.json"
MAX_LOGIN_ATTEMPTS = 3

def load_security_data():
    """加载安全数据"""
    if not os.path.exists(SECURITY_FILE):
        return {"blacklist": [], "attempts": {}}
    try:
        with open(SECURITY_FILE, 'r') as f:
            return json.load(f)
    except:
        return {"blacklist": [], "attempts": {}}

def save_security_data(data):
    """保存安全数据"""
    try:
        with open(SECURITY_FILE, 'w') as f:
            json.dump(data, f, indent=4)
    except Exception as e:
        print(f"Failed to save security data: {e}")

def get_client_ip():
    """获取客户端真实IP"""
    if request.headers.getlist("X-Forwarded-For"):
        return request.headers.getlist("X-Forwarded-For")[0]
    return request.remote_addr

def cleanup_old_images():
    """清理旧文件/签名，保留最新的500张/个"""
    try:
        files = glob.glob(os.path.join(IMAGE_CACHE_DIR, "*"))
        if len(files) <= 1000:
            return
        files.sort(key=os.path.getctime)
        files_to_delete = files[:len(files) - 500]
        for f in files_to_delete:
            try:
                os.remove(f)
            except Exception as e:
                print(f"Error deleting old cached file {f}: {e}")
    except Exception as e:
        print(f"Cleanup failed: {e}")

def process_and_save_file(file):
    """保存上传的文件（图片或PDF），严格检查最大10MB限制"""
    cleanup_old_images()

    # 校验文件大小 (10MB Max per file)
    file.seek(0, os.SEEK_END)
    size = file.tell()
    file.seek(0)
    
    MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB
    if size > MAX_FILE_SIZE:
        raise ValueError(f"File '{file.filename}' exceeds 10MB size limit (文件大小不能超过10MB)")

    original_filename = file.filename or "file.dat"
    original_ext = os.path.splitext(original_filename)[1].lower()
    
    # 检查是否为 PDF 文档
    if original_ext == '.pdf' or file.mimetype == 'application/pdf':
        filename = f"{uuid.uuid4()}.pdf"
        filepath = os.path.join(IMAGE_CACHE_DIR, filename)
        file.save(filepath)
        print(f"[Upload PDF] Saved PDF: {filepath}, size: {size} bytes")
        return filename, 'pdf', original_filename

    # 图片处理逻辑
    is_heic = original_ext in ['.heic', '.heif']
    if is_heic:
        ext = '.jpg'
    elif original_ext in ['.jpg', '.jpeg', '.png', '.webp', '.gif']:
        ext = original_ext
    else:
        ext = '.jpg'

    filename = f"{uuid.uuid4()}{ext}"
    filepath = os.path.join(IMAGE_CACHE_DIR, filename)
    temp_filepath = os.path.join(IMAGE_CACHE_DIR, f"temp_{uuid.uuid4()}{original_ext}")
    file.save(temp_filepath)

    try:
        with Image.open(temp_filepath) as img:
            file_size = os.path.getsize(temp_filepath)
            width, height = img.size
            needs_resize = file_size > 5 * 1024 * 1024 or (width * height) > 1e7
            needs_conversion = is_heic or (original_ext not in ['.jpg', '.jpeg', '.png', '.webp', '.gif'])

            if needs_conversion or needs_resize:
                if needs_resize:
                    img.thumbnail((1920, 1920))
                if img.mode not in ("RGB",):
                    img = img.convert("RGB")
                img.save(filepath, "JPEG", quality=85)
            else:
                shutil.move(temp_filepath, filepath)
                temp_filepath = None
    except Exception as e:
        if temp_filepath and os.path.exists(temp_filepath):
            try: os.remove(temp_filepath)
            except: pass
        raise Exception(f"Failed to process image: {str(e)}")
    finally:
        if temp_filepath and os.path.exists(temp_filepath):
            try: os.remove(temp_filepath)
            except: pass

    return filename, 'image', original_filename

def encode_image_from_path(image_path):
    """读取本地图片并转换为Base64，供LLM API调用"""
    try:
        with open(image_path, "rb") as image_file:
            return base64.b64encode(image_file.read()).decode('utf-8')
    except:
        return None

# Gemini Files API 缓存管理
GEMINI_FILE_CACHE = {}

def get_gemini_file_uri(local_filename, original_name=None):
    """
    通过 Google Gemini Files API 上传本地 PDF 文件并返回 fileUri
    参考: https://ai.google.dev/gemini-api/docs/document-processing#python_2
    """
    cached = GEMINI_FILE_CACHE.get(local_filename)
    if cached and (time.time() - cached.get("timestamp", 0) < 3600 * 24):
        return cached["uri"]

    local_path = os.path.join(IMAGE_CACHE_DIR, local_filename)
    if not os.path.exists(local_path):
        raise FileNotFoundError(f"Local cached file {local_filename} not found")

    display_name = original_name or local_filename
    print(f"[Gemini Files API] Uploading local PDF {local_path} ({os.path.getsize(local_path)} bytes)...")

    init_url = f"https://generativelanguage.googleapis.com/upload/v1beta/files?key={GEMINI_API_KEY}"
    file_size = os.path.getsize(local_path)
    headers = {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": str(file_size),
        "X-Goog-Upload-Header-Content-Type": "application/pdf",
        "Content-Type": "application/json"
    }
    file_metadata = {"file": {"display_name": display_name}}

    resp = requests.post(init_url, headers=headers, json=file_metadata, timeout=30)
    resp.raise_for_status()
    upload_url = resp.headers.get("X-Goog-Upload-URL")

    with open(local_path, "rb") as f:
        file_bytes = f.read()

    upload_headers = {
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize",
        "Content-Type": "application/pdf"
    }
    up_resp = requests.post(upload_url, headers=upload_headers, data=file_bytes, timeout=60)
    up_resp.raise_for_status()

    res_json = up_resp.json()
    file_info = res_json.get("file", {})
    file_uri = file_info.get("uri")
    print(f"[Gemini Files API] Successfully uploaded PDF. URI: {file_uri}")

    GEMINI_FILE_CACHE[local_filename] = {
        "uri": file_uri,
        "name": file_info.get("name"),
        "timestamp": time.time()
    }
    return file_uri

# --- Routes ---

@app.route('/')
def index():
    return send_from_directory('static', 'index.html')

@app.route('/assets/<path:filename>')
def serve_assets(filename):
    """提供assets目录的静态文件访问"""
    return send_from_directory('assets', filename)

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory('static', path)

@app.route('/api/auth/login', methods=['POST'])
def login():
    client_ip = get_client_ip()
    security_data = load_security_data()
    
    if client_ip in security_data.get("blacklist", []):
        time.sleep(1) 
        return jsonify({"success": False, "error": "Access denied. IP banned."}), 403

    data = request.json
    if not data or 'password' not in data:
        return jsonify({"success": False, "error": "Invalid request"}), 400

    password = str(data.get('password', ''))
    if len(password) > 100:
        return jsonify({"success": False, "error": "Input too long"}), 400

    if password == SITE_PASSWORD:
        if client_ip in security_data["attempts"]:
            del security_data["attempts"][client_ip]
            save_security_data(security_data)
        session['authenticated'] = True
        session.permanent = True
        return jsonify({"success": True})
    else:
        attempts = security_data["attempts"].get(client_ip, 0) + 1
        security_data["attempts"][client_ip] = attempts
        if attempts >= MAX_LOGIN_ATTEMPTS:
            if client_ip not in security_data["blacklist"]:
                security_data["blacklist"].append(client_ip)
            if client_ip in security_data["attempts"]:
                del security_data["attempts"][client_ip]
            save_security_data(security_data)
            return jsonify({"success": False, "error": "Too many failed attempts. Banned."}), 403
        else:
            save_security_data(security_data)
            return jsonify({"success": False, "error": "Incorrect password."}), 401

@app.route('/api/auth/check', methods=['GET'])
def check_auth():
    return jsonify({"authenticated": session.get('authenticated', False)})

def check_session():
    if not session.get('authenticated'):
        return False
    return True

@app.route('/images/cache/<path:filename>')
def serve_cached_image(filename):
    """提供图片及PDF文件访问"""
    if filename.endswith('.pdf'):
        return send_from_directory(IMAGE_CACHE_DIR, filename, mimetype='application/pdf')
    return send_from_directory(IMAGE_CACHE_DIR, filename)

@app.route('/api/upload', methods=['POST'])
def upload_file_route():
    """处理图片和PDF文档上传，单文件限制10MB"""
    if not session.get('authenticated'):
        return jsonify({"error": "Unauthorized"}), 401

    if 'file' not in request.files:
        return jsonify({"error": "No file part"}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({"error": "No selected file"}), 400

    try:
        filename, file_type, original_name = process_and_save_file(file)
        url = f"/images/cache/{filename}"
        return jsonify({
            "url": url,
            "name": original_name,
            "file_type": file_type,
            "is_pdf": file_type == 'pdf'
        })
    except ValueError as ve:
        return jsonify({"error": str(ve)}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# --- Chat & Gemini Logic ---

def convert_openai_to_gemini(messages):
    """转换前端消息列表为 Google Gemini 原生 contents 结构"""
    gemini_contents = []
    for msg in messages:
        role = msg.get('role')
        content = msg.get('content', '')
        
        if role == 'assistant': gemini_role = 'model'
        elif role == 'user': gemini_role = 'user'
        else: continue 

        parts = []
        if isinstance(content, str):
            parts.append({"text": content})
        elif isinstance(content, list):
            for item in content:
                item_type = item.get("type")
                if item_type == "text":
                    parts.append({"text": item.get("text", "")})
                elif item_type == "image_url":
                    image_url_obj = item.get("image_url", {})
                    url = image_url_obj.get("url", "")

                    if url.startswith("/images/cache/"):
                        filename = url.split("/")[-1]
                        local_path = os.path.join(IMAGE_CACHE_DIR, filename)
                        
                        # 处理 PDF 文档
                        if filename.lower().endswith(".pdf"):
                            try:
                                original_name = item.get("name") or filename
                                file_uri = get_gemini_file_uri(filename, original_name)
                                parts.append({
                                    "fileData": {
                                        "mimeType": "application/pdf",
                                        "fileUri": file_uri
                                    }
                                })
                            except Exception as e:
                                print(f"[Gemini] PDF process error: {e}")
                        else:
                            # 图片 base64 inlineData
                            base64_str = encode_image_from_path(local_path)
                            if base64_str:
                                mime_type = "image/jpeg"
                                if filename.endswith('.png'): mime_type = "image/png"
                                elif filename.endswith('.webp'): mime_type = "image/webp"
                                parts.append({
                                    "inlineData": {
                                        "mimeType": mime_type,
                                        "data": base64_str
                                    }
                                })
                    elif url.startswith("data:"):
                        try:
                            header, base64_data = url.split(",", 1)
                            mime_type = header.split(":")[1].split(";")[0]
                            parts.append({
                                "inlineData": {
                                    "mimeType": mime_type,
                                    "data": base64_data
                                }
                            })
                        except: pass

                elif item_type == "file_url":
                    file_url_obj = item.get("file_url", {})
                    url = file_url_obj.get("url", "") or item.get("url", "")
                    if url.startswith("/images/cache/"):
                        filename = url.split("/")[-1]
                        original_name = file_url_obj.get("name") or item.get("name") or filename
                        try:
                            file_uri = get_gemini_file_uri(filename, original_name)
                            parts.append({
                                "fileData": {
                                    "mimeType": "application/pdf",
                                    "fileUri": file_uri
                                }
                            })
                        except Exception as e:
                            print(f"[Gemini] PDF process error: {e}")

                if 'thoughtSignature' in item:
                    if parts:
                        parts[-1]['thoughtSignature'] = item.get('thoughtSignature')
        
        if parts:
            gemini_contents.append({"role": gemini_role, "parts": parts})
    return gemini_contents

def stream_gemini_native(model_name, messages):
    """使用 Google Gemini 原生 API 进行流式生成"""
    target_url = GEMINI_NATIVE_URL.format(model=model_name) + f"?key={GEMINI_API_KEY}"
    headers = {"Content-Type": "application/json"}
    contents = convert_openai_to_gemini(messages)
    
    payload = {
        "contents": contents,
        "system_instruction": {"parts": [{"text": DEFAULT_SYSTEM_PROMPT}]},
        "generationConfig": {
            "temperature": TEMPERATURE,
            "maxOutputTokens": MAX_OUTPUT_TOKENS,
        }
    }

    try:
        with requests.post(target_url, json=payload, headers=headers, stream=True, timeout=60) as resp:
            if resp.status_code != 200:
                error_msg = f"Gemini API Error ({resp.status_code}): {resp.text}"
                print(error_msg)
                yield f"data: {json.dumps({'error': error_msg})}\n\n"
                return

            buffer = ""
            for line in resp.iter_lines():
                if not line: continue
                decoded_line = line.decode('utf-8').strip()
                buffer += decoded_line

                clean_buffer = buffer
                if clean_buffer.startswith(','): clean_buffer = clean_buffer[1:]
                if clean_buffer.startswith('['): clean_buffer = clean_buffer[1:]
                if clean_buffer.endswith(','): clean_buffer = clean_buffer[:-1]
                if clean_buffer.endswith(']'): clean_buffer = clean_buffer[:-1]
                
                try:
                    chunk_json = json.loads(clean_buffer)
                    buffer = "" 
                    candidates = chunk_json.get('candidates', [])
                    if candidates:
                        parts = candidates[0].get('content', {}).get('parts', [])
                        text_chunk = ""
                        for part in parts:
                            if 'text' in part: text_chunk += part['text']
                        if text_chunk:
                            openai_chunk = {
                                "id": "chatcmpl-gemini",
                                "object": "chat.completion.chunk",
                                "created": int(time.time()),
                                "model": model_name,
                                "choices": [{"index": 0, "delta": {"content": text_chunk}, "finish_reason": None}]
                            }
                            yield f"data: {json.dumps(openai_chunk)}\n\n"
                except json.JSONDecodeError:
                    continue
                except Exception as e:
                    print(f"Gemini Parse Error: {e}")
                    buffer = ""
            yield "data: [DONE]\n\n"
    except Exception as e:
        yield f"data: {json.dumps({'error': str(e)})}\n\n"

@app.route('/api/chat/generate-title', methods=['POST'])
def generate_title():
    """基于用户首条消息生成对话标题"""
    if not check_session(): 
        return jsonify({"error": "Unauthorized"}), 401
    
    data = request.json
    first_message = data.get('message', '')
    
    if not first_message:
        return jsonify({"title": "New Chat"})
    
    if len(first_message) > 500:
        first_message = first_message[:500] + "..."
    
    title_prompt = f"""Based on the following user message, generate a short and concise title in Chinese that summarizes the topic. 
Only respond with the title itself, no quotes, no explanation, no punctuation at the end.

User message: {first_message}

Title:"""
    
    model_name = "gemini-3.6-flash"
    target_url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={GEMINI_API_KEY}"
    headers = {"Content-Type": "application/json"}
    
    payload = {
        "contents": [{"parts": [{"text": title_prompt}]}],
        "generationConfig": {
            "temperature": 1.0,
            "maxOutputTokens": 50,
        }
    }
    
    try:
        resp = requests.post(target_url, json=payload, headers=headers, timeout=10)
        if resp.status_code != 200 or resp.json() == []:
            print(f"Title generation error: {resp.text}")
            return jsonify({"title": "New Chat"})

        resp_json = resp.json()
        candidates = resp_json.get('candidates', [])
        if not candidates:
            return jsonify({"title": "New Chat"})
        
        parts = candidates[0].get('content', {}).get('parts', [])
        if parts and 'text' in parts[0]:
            title = parts[0]['text'].strip().strip('"\'')
            if len(title) > 50:
                title = title[:47] + "..."
            return jsonify({"title": title if title else "New Chat"})
        
        return jsonify({"title": "New Chat"})
    except Exception as e:
        print(f"Title generation failed: {e}")
        return jsonify({"title": "New Chat"})

@app.route('/api/chat/completions', methods=['POST'])
def chat_proxy():
    """统一的对话 API 接口，全面基于 Google Gemini 原生 API"""
    if not check_session(): return jsonify({"error": "Unauthorized"}), 401
    
    data = request.json
    model = data.get('model', 'gemini-3.6-flash')
    raw_messages = data.get('messages', [])
    
    MAX_HISTORY = 20
    if len(raw_messages) > MAX_HISTORY:
        raw_messages = raw_messages[-MAX_HISTORY:]

    return Response(stream_with_context(stream_gemini_native(model, raw_messages)), content_type='text/event-stream')

@app.route('/api/images/generations', methods=['POST'])
def image_proxy():
    if not check_session(): return jsonify({"error": "Unauthorized"}), 401
    
    req_data = request.json
    messages = req_data.get('messages', [])
    
    if not messages:
        prompt = req_data.get('prompt', '')
        if prompt:
            messages = [{"role": "user", "content": prompt}]
            if req_data.get('image_url'): 
                messages[0]["content"] = [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": req_data.get('image_url')}}
                ]

    gemini_contents = convert_openai_to_gemini(messages)
    
    gemini_model = req_data.get('model', 'gemini-3.1-flash-image')
    if gemini_model not in ["gemini-3.1-flash-image", "gemini-3-pro-image-preview"]:
        gemini_model = "gemini-3.1-flash-image"
    google_url = f"https://generativelanguage.googleapis.com/v1beta/models/{gemini_model}:generateContent?key={GEMINI_API_KEY}"
    
    image_size = req_data.get('size', '2K')
    if image_size not in ["1K", "2K", "4K"]:
        image_size = "2K"

    payload = {
        "contents": gemini_contents,
        "generationConfig": {
            "responseModalities": ["IMAGE"],
            "imageConfig": { "imageSize": image_size }
        }
    }
    headers = { "Content-Type": "application/json" }
    
    try:
        resp = requests.post(google_url, json=payload, headers=headers)
        if resp.status_code != 200: 
            return jsonify({"error": {"message": f"Gemini API Error: {resp.text}"}}), resp.status_code
        
        resp_json = resp.json()
        candidates = resp_json.get('candidates', [])
        if not candidates: 
            return jsonify({"error": {"message": "Image generation failed."}}), 500
        
        parts = candidates[0].get('content', {}).get('parts', [])
        
        target_part = None
        for part in reversed(parts):
            if 'inlineData' in part or 'inline_data' in part:
                target_part = part
                break
        
        if not target_part: 
            return jsonify({"error": {"message": "Model refused or returned no image."}}), 500

        image_data_obj = target_part.get('inlineData') or target_part.get('inline_data')
        img_data = base64.b64decode(image_data_obj.get('data'))
        
        file_ext = ".jpg"
        if image_data_obj.get('mimeType') == 'image/png': file_ext = ".png"
        
        filename = f"{uuid.uuid4()}"
        filepath = os.path.join(IMAGE_CACHE_DIR, f"{filename}{file_ext}")
        
        with open(filepath, "wb") as f:
            f.write(img_data)
        
        image_url = f"/images/cache/{filename}{file_ext}"
        cleanup_old_images()

        raw_thought_signature = target_part.get('thoughtSignature')
        sig_ext = ".sig"
        sig_path = os.path.join(IMAGE_CACHE_DIR, f"{filename}{sig_ext}")
        with open(sig_path, "w") as f:
            f.write(raw_thought_signature or "")

        sig_url = f"/images/cache/{filename}{sig_ext}"

        return jsonify({
            "created": int(time.time()), 
            "data": [{
                "url": image_url,
                "thoughtSignature": sig_url
            }]
        })

    except Exception as e: 
        return jsonify({"error": {"message": str(e)}}), 500

if __name__ == '__main__':
    app.run(host='127.0.0.1', port=8080, debug=False)
