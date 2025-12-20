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

# --- Configuration ---
SITE_PASSWORD = os.getenv("SITE_PASSWORD", "lwtlwt123")

# OpenAI Config
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")

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
    """清理旧图片/签名，保留最新的500张"""
    try:
        # 获取所有图片文件及其创建时间
        files = glob.glob(os.path.join(IMAGE_CACHE_DIR, "*"))
        if len(files) <= 1000:
            return

        # 按时间排序 (旧 -> 新)
        files.sort(key=os.path.getctime)
        
        # 删除旧的，只留最新的500张
        files_to_delete = files[:len(files) - 500]
        for f in files_to_delete:
            try:
                os.remove(f)
            except Exception as e:
                print(f"Error deleting old image {f}: {e}")
    except Exception as e:
        print(f"Cleanup failed: {e}")


def process_and_save_image(file):
    """保存图片，检查大小并Resize，自动转换 HEIC/HEIF 格式为 JPEG"""
    cleanup_old_images() # 每次上传前检查是否需要清理

    original_ext = os.path.splitext(file.filename)[1].lower()
    print(f"[Upload] Received file: {file.filename}, extension: {original_ext}")
    
    # 检查是否是 HEIC/HEIF 格式（iPhone 默认图片格式）
    is_heic = original_ext in ['.heic', '.heif']
    
    # 确定最终保存的扩展名
    if is_heic:
        # HEIC/HEIF 转换为 JPEG
        ext = '.jpg'
        print(f"[Upload] Detected HEIC/HEIF format, will convert to JPEG")
    elif original_ext in ['.jpg', '.jpeg', '.png', '.webp', '.gif']:
        ext = original_ext
    else:
        # 未知格式也尝试转换为 JPEG
        ext = '.jpg'
        print(f"[Upload] Unknown format '{original_ext}', will attempt to convert to JPEG")
    
    filename = f"{uuid.uuid4()}{ext}"
    filepath = os.path.join(IMAGE_CACHE_DIR, filename)

    # 先保存原始文件到临时路径以便处理
    temp_filepath = os.path.join(IMAGE_CACHE_DIR, f"temp_{uuid.uuid4()}{original_ext}")
    file.save(temp_filepath)
    print(f"[Upload] Saved temp file: {temp_filepath}, size: {os.path.getsize(temp_filepath)} bytes")

    try:
        with Image.open(temp_filepath) as img:
            print(f"[Upload] Opened image successfully, mode: {img.mode}, size: {img.size}")
            
            # 检查条件
            file_size = os.path.getsize(temp_filepath)
            width, height = img.size
            num_pixels = width * height

            # 对于 HEIC/HEIF、未知格式或大图片进行处理
            needs_resize = file_size > 5 * 1024 * 1024 or num_pixels > 1e7
            needs_conversion = is_heic or (original_ext not in ['.jpg', '.jpeg', '.png', '.webp', '.gif'])
            
            if needs_conversion or needs_resize:
                # 如果需要 resize
                if needs_resize:
                    img.thumbnail((1920, 1920))
                    print(f"[Upload] Resized large image to: {img.size}")
                
                # 转换颜色模式（HEIC 可能有 RGBA 或其他模式）
                if img.mode not in ("RGB",):
                    print(f"[Upload] Converting color mode from {img.mode} to RGB")
                    img = img.convert("RGB")
                
                # 保存为 JPEG
                img.save(filepath, "JPEG", quality=85)
                print(f"[Upload] Saved converted image: {filepath}")
            else:
                # 不需要转换，直接移动文件
                shutil.move(temp_filepath, filepath)
                temp_filepath = None  # 标记已经移动，不需要删除
                print(f"[Upload] Moved file directly: {filepath}")
                
    except Exception as e:
        print(f"[Upload] Image processing error: {e}")
        import traceback
        traceback.print_exc()
        
        # 如果处理失败，抛出异常让调用方知道
        if temp_filepath and os.path.exists(temp_filepath):
            try:
                os.remove(temp_filepath)
            except:
                pass
        raise Exception(f"Failed to process image: {str(e)}")
        
    finally:
        # 清理临时文件
        if temp_filepath and os.path.exists(temp_filepath):
            try:
                os.remove(temp_filepath)
                print(f"[Upload] Cleaned up temp file: {temp_filepath}")
            except:
                pass

    return filename

def encode_image_from_path(image_path):
    """读取本地图片并转换为Base64，供LLM API调用"""
    try:
        with open(image_path, "rb") as image_file:
            return base64.b64encode(image_file.read()).decode('utf-8')
    except:
        return None

# --- Routes ---

@app.route('/')
def index():
    return send_from_directory('static', 'index.html')

@app.route('/assets/<path:filename>')
def serve_assets(filename):
    """提供assets目录的静态文件访问（如logo）"""
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
            return jsonify({"success": False, "error": f"Incorrect password."}), 401

@app.route('/api/auth/check', methods=['GET'])
def check_auth():
    return jsonify({"authenticated": session.get('authenticated', False)})

def check_session():
    if not session.get('authenticated'):
        return False
    return True

@app.route('/images/cache/<path:filename>')
def serve_cached_image(filename):
    """提供图片访问"""
    return send_from_directory(IMAGE_CACHE_DIR, filename)

@app.route('/api/upload', methods=['POST'])
def upload_image():
    """处理图片上传"""
    if not session.get('authenticated'):
        return jsonify({"error": "Unauthorized"}), 401

    if 'file' not in request.files:
        return jsonify({"error": "No file part"}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({"error": "No selected file"}), 400

    try:
        filename = process_and_save_image(file)
        # 返回相对URL
        url = f"/images/cache/{filename}"
        return jsonify({"url": url})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# --- Chat Logic (Modified for Local Image Handling) ---

def process_messages_for_llm(messages):
    processed_messages = []
    for msg in messages:
        new_msg = msg.copy()
        content = msg.get('content')
        
        if isinstance(content, list):
            new_content = []
            for item in content:
                if item.get('type') == 'image_url':
                    image_url_obj = item.get('image_url', {})
                    url = image_url_obj.get('url', '')
                    
                    if url.startswith('/images/cache/'):
                        filename = url.split('/')[-1]
                        local_path = os.path.join(IMAGE_CACHE_DIR, filename)
                        base64_str = encode_image_from_path(local_path)
                        
                        if base64_str:
                            mime_type = "image/jpeg"
                            if filename.endswith('.png'): mime_type = "image/png"
                            elif filename.endswith('.webp'): mime_type = "image/webp"
                            
                            new_content.append({
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:{mime_type};base64,{base64_str}" 
                                }
                            })
                        else:
                            raise Exception("Invalid image URL")
                    else:
                        raise Exception("Invalid image URL")
                else:
                    new_content.append(item)

                if 'thoughtSignature' in item:
                    if item.get('thoughtSignature').startswith('/images/cache/'):
                        filename = item.get('thoughtSignature').split('/')[-1]
                        local_path = os.path.join(IMAGE_CACHE_DIR, filename)
                        with open(local_path, 'r') as f:
                            base64_str = f.read()
                        new_content[-1]['thoughtSignature'] = base64_str
                    else:
                        raise Exception("Invalid signature URL")

            new_msg['content'] = new_content
            
        processed_messages.append(new_msg)
    return processed_messages

def convert_openai_to_gemini(messages):
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
                if item.get("type") == "text":
                    parts.append({"text": item.get("text", "")})
                elif item.get("type") == "image_url":
                    image_url_obj = item.get("image_url", {})
                    image_url = image_url_obj.get("url", "")

                    if image_url.startswith("data:"):
                        try:
                            header, base64_data = image_url.split(",", 1)
                            mime_type = header.split(":")[1].split(";")[0]
                            
                            part = {
                                "inlineData": {
                                    "mimeType": mime_type,
                                    "data": base64_data
                                }
                            }
                            parts.append(part)
                        except: pass

                if 'thoughtSignature' in item:
                    parts[-1]['thoughtSignature'] = item.get('thoughtSignature')
        
        if parts:
            gemini_contents.append({"role": gemini_role, "parts": parts})
    return gemini_contents

def stream_gemini_native(model_name, messages):
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
        with requests.post(target_url, json=payload, headers=headers, stream=True) as resp:
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
    
    # 限制消息长度以避免过长的请求
    if len(first_message) > 500:
        first_message = first_message[:500] + "..."
    
    # 使用固定的 prompt 模板
    title_prompt = f"""Based on the following user message, generate a short and concise title in Chinese that summarizes the topic. 
Only respond with the title itself, no quotes, no explanation, no punctuation at the end.

User message: {first_message}

Title:"""
    
    # 使用 gemini-2.5-flash 模型
    model_name = "gemini-2.5-flash"
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
            title = parts[0]['text'].strip()
            # 清理标题：移除引号和多余空白
            title = title.strip('"\'')
            # 限制长度
            if len(title) > 50:
                title = title[:47] + "..."
            return jsonify({"title": title if title else "New Chat"})
        
        return jsonify({"title": "New Chat"})
    except Exception as e:
        print(f"Title generation failed: {e}")
        return jsonify({"title": "New Chat"})


@app.route('/api/chat/completions', methods=['POST'])
def chat_proxy():
    if not check_session(): return jsonify({"error": "Unauthorized"}), 401
    
    data = request.json
    model = data.get('model', 'gpt-3.5-turbo')
    raw_messages = data.get('messages', [])
    
    # 限制历史长度
    MAX_HISTORY = 20
    if len(raw_messages) > MAX_HISTORY: raw_messages = raw_messages[-MAX_HISTORY:]

    # 将本地 URL 转换为 Base64 供 API 使用
    processed_messages = process_messages_for_llm(raw_messages)

    # --- 1. Gemini 分支 ---
    if "gemini" in model.lower():
        # stream_gemini_native 内部会调用 convert_openai_to_gemini
        return Response(stream_with_context(stream_gemini_native(model, processed_messages)), content_type='text/event-stream')
    
    # --- 2. OpenAI 分支 ---
    else:
        headers = {
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 ..."
        }
        
        has_system = any(m.get('role') == 'system' for m in processed_messages)
        if not has_system: 
            processed_messages.insert(0, {"role": "system", "content": DEFAULT_SYSTEM_PROMPT})
        
        payload = {
            "model": model,
            "messages": processed_messages, # 发送带 Base64 的消息
            "stream": True
        }

        try:
            resp = requests.post(f"{OPENAI_BASE_URL}/chat/completions", json=payload, headers=headers, stream=True)
            if resp.status_code != 200:
                return jsonify({"error": resp.text}), resp.status_code

            def generate_openai():
                for chunk in resp.iter_content(chunk_size=1024):
                    if chunk: yield chunk

            return Response(stream_with_context(generate_openai()), content_type=resp.headers.get('Content-Type'))
        except Exception as e:
            return jsonify({"error": str(e)}), 500

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

    processed_messages = process_messages_for_llm(messages)
    gemini_contents = convert_openai_to_gemini(processed_messages)
    
    gemini_model = "gemini-3-pro-image-preview"
    google_url = f"https://generativelanguage.googleapis.com/v1beta/models/{gemini_model}:generateContent?key={GEMINI_API_KEY}"
    
    payload = {
        "contents": gemini_contents,
        "generationConfig": { "responseModalities": ["IMAGE"] }
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

        # 获取图片数据
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

        # 写入签名
        raw_thought_signature = target_part.get('thoughtSignature')
        sig_ext = ".sig"
        sig_path = os.path.join(IMAGE_CACHE_DIR, f"{filename}{sig_ext}")
        with open(sig_path, "w") as f:
            f.write(raw_thought_signature)

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