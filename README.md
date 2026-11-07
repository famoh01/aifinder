# AIFinder AI Ultimate V2.4 Max

ชุดอัดแน่นที่สุดของสาย V2.x ในสcopes นี้ — ข้อมูลจริง + เครื่องมือครบในแอปเดียว

## สิ่งที่อัดเข้าไป

### ข้อมูล / ความรู้
- Local models ~**50,025** (จริงจาก HF + curated)
- Live Hugging Face API (ระดับ **200k+** โมเดลสาธารณะ)
- AI Products ~**98** รายการ (ชื่อ + เว็บจริง)
- All Links **203** ลิงก์ รวมไฟล์เดียว (`all-links.*`)
- Catalog insights + ai-knowledge (หลักการเลือกโมเดล)

### แท็บ / ฟีเจอร์ UI
- AI Studio + แม่แบบคำสั่ง + Model Directory RAG
- Dashboard สถิติระบบ
- Model Directory (chips, fav, เปรียบเทียบ, export)
- AI Products browser
- All Links browser + ดาวน์โหลด
- Code Analyzer, Game Inspector, Server Manager, Research, Projects

### API เด่น
- `/api/stats` `/api/models` `/api/models/live` `/api/models/detail`
- `/api/models/compare` `/api/models/advise` `/api/ai-products` `/api/all-links`
- `/api/prompt-templates` `/api/chat` (useCatalog)

### ความปลอดภัยเบื้องต้น
- Rate limit, security headers, admin token สำหรับ Docker

## รัน
```bash
npm install && npm start
```
http://localhost:8080

## ข้อจำกัดที่ยังเป็นจริง
- ไม่ได้เทรนน้ำหนักโมเดลจากรายชื่อ 50k
- ไม่ฝัง 200k แถวใน ZIP (ใช้ Live API แทน)
- แอป single-user starter ไม่ใช่ multi-tenant SaaS เต็มรูปแบบ
