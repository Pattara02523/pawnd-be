# PAWND AI: free-only deployment

ตรวจ catalog สาธารณะของ OpenRouter วันที่ 2026-09-05 โดยไม่ใช้ API key และไม่ได้ส่งรูปไป inference

## Railway variables

```text
AI_MOCK_MODE=false
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
AI_ANALYZE_IMAGE_MODEL=openrouter/free
AI_ANALYZE_IMAGE_MODEL_FREE=openrouter/free
AI_IMAGE_EMBEDDING_MODEL=nvidia/llama-nemotron-embed-vl-1b-v2:free
AI_IMAGE_EMBEDDING_DIMENSION=768
```

OPENROUTER_API_KEY ใช้ key ที่เจ้าของตั้งไว้บน Railway เท่านั้น ไม่ใส่ใน Vercel หรือเอกสาร
AI_PET_AVATAR_MODEL สามารถลบค่า seed-story ออกได้ เพราะ release นี้ปิดการสร้าง Avatar จริงก่อนเรียก provider/หักโควตา แม้จะมีค่าเก่าค้างอยู่ก็ตาม

## โมเดลที่เลือกและขอบเขต

- openrouter/free เลือกเฉพาะโมเดลฟรีและกรองความสามารถตามคำขอ (รูปภาพ + JSON schema)
- embedding ตัวที่เลือกยังมีใน catalog, รองรับ image input และราคา token เป็นศูนย์
- วิเคราะห์และ embedding ปฏิเสธ model ID ที่ไม่ใช่ :free/openrouter/free ก่อน inference และส่ง provider.max_price เป็นศูนย์สำหรับ prompt/completion/request/image
- OpenRouter base URL ฝั่ง client ถูกตรึงไว้ที่ API ทางการเพื่อให้การควบคุมราคานี้มีความหมาย
- ไม่มีการรับประกัน SLA หรือจำนวนคำขอฟรี; endpoint อาจตอบ 429 หรือไม่มี provider ว่างได้
- ยังไม่พบโมเดล Avatar ฟรีที่ยืนยันรองรับได้ จึงแจ้งว่าไม่พร้อมใช้งาน ไม่สร้างภาพจำลองแทนภาพจริงใน Production
- ไม่เปลี่ยน vector dimension หรือ migration ใน release นี้ ต้องทดสอบว่า provider คืน 768 มิติจริง หากไม่ตรงระบบจะปฏิเสธ ไม่ตัด vector เอง
- NVIDIA model นี้ออกแบบเพื่อ multimodal retrieval ไม่ได้ผ่านการประเมินว่าแยกสัตว์ตัวเดียวกันได้แม่นยำ ต้องทดสอบภาพจริงหลายมุมก่อนใช้คะแนนเป็นข้อสรุป

## ก่อน deploy

1. ตั้งค่าข้างต้นให้ครบ แล้วนำ Backend commit ใหม่ขึ้นก่อน Frontend
2. ตรวจ Railway build/start สำเร็จ ไม่มี ENV Validation failed
3. ตรวจ PostgreSQL มี pgvector และ migrations เดิมครบ
4. ไม่ต้องเติมเครดิตเพื่อเริ่มทดสอบ และไม่ตั้ง fallback ไปโมเดลคิดเงิน

## ตรวจรับหลัง deploy (ยังไม่ได้ทดสอบกับบัญชีจริง)

1. Login แล้วใช้รูปสัตว์ที่อนุญาตให้ทดสอบ กดวิเคราะห์ภาพ ตรวจว่าประเภท/สี/คำบรรยายมาจากภาพ ไม่ใช่ข้อมูล mock
2. สร้างประกาศ LOST และ FOUND ประเภทเดียวกันอย่างละหนึ่ง อัปโหลดรูปที่คล้ายกัน ตรวจผลจับคู่
3. หากมีข้อความ AI ขัดข้อง รูปยังต้องถูกบันทึก ห้ามอัปโหลดซ้ำ ให้กดจับคู่ใหม่เมื่อโควตาพร้อม
4. ตรวจ embedding มี dimension=768 และ model_name ขึ้นต้น live-v2:; ถ้า dimension ไม่ตรง ต้องเลือกโมเดลใหม่หรือเตรียม migration แยกก่อนเปิด matching จริง
5. ค้นหาด้วยรูป ต้องพบเฉพาะข้อมูล ACTIVE ที่มี embedding จริงชุดใหม่
6. ทดลอง Avatar ต้องได้ข้อความไม่พร้อมใช้งานและไม่มีการหักโควตาหรือเรียก provider
7. ตรวจ OpenRouter Activity ว่าค่าใช้จ่ายของคำขอทดสอบเป็นศูนย์

## ข้อมูล embedding เดิม

แยก namespace ใหม่ live-v2/model/dimension กับ mock-v2/model/dimension ในคอลัมน์ model_name เดิม เพื่อไม่เปรียบเทียบค่าจำลองกับ AI จริง ไม่มีการลบข้อมูลเดิม

รูปเก่าจะยังไม่อยู่ในผลค้นหาด้วยรูปจนสร้าง embedding ใหม่ เจ้าของประกาศกดจับคู่ใหม่เพื่อสร้าง embedding ให้รูปของประกาศนั้นได้ ทำกับประกาศที่ต้องการนำกลับเข้าค้นหาทีละรายการตามโควตาฟรี หลังสร้างครบแล้วกดจับคู่ประกาศต้นทางอีกครั้งเพื่อคำนวณคะแนนใหม่

ผล AiMatch เก่าที่บันทึกไว้ไม่ได้ถูกลบหรือรับรองใหม่อัตโนมัติ ต้องตรวจและคำนวณใหม่ก่อนนำผลเก่ามาอ้างว่าเป็นผลจากโมเดลจริง

## Sources

- https://openrouter.ai/openrouter/free
- https://openrouter.ai/api/v1/models
- https://openrouter.ai/api/v1/embeddings/models
- https://openrouter.ai/api/v1/images/models
- https://openrouter.ai/docs/guides/routing/provider-selection#max-price
- https://build.nvidia.com/nvidia/llama-nemotron-embed-vl-1b-v2/modelcard
