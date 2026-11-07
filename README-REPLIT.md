# AIFinder Ultimate V2.4 Max — สำหรับ Replit

## วิธีรันบน Replit

1. สร้าง Repl ใหม่ → เลือก **Node.js**
2. อัปโหลดไฟล์ทั้งหมดในโฟลเดอร์นี้เข้าไป (หรือลาก zip แล้วแตก)
3. กดปุ่ม **Run** (หรือรันคำสั่ง `npm install && npm start`)
4. รอสักครู่ แล้วกดปุ่ม **Open in new tab** ที่โผล่ขึ้นมา

### หมายเหตุ
- โปรเจกต์นี้ใช้ `process.env.PORT` อยู่แล้ว รองรับ Replit ได้ทันที
- ไฟล์ `data/models-seed.json` มีขนาดค่อนข้างใหญ่ (~24MB) การโหลดครั้งแรกอาจใช้เวลาสักครู่
- ถ้าต้องการใช้ฟีเจอร์ Chat จริง ต้องใส่ API Key ในหน้าเว็บเอง
- Free plan ของ Replit อาจ sleep เมื่อไม่ใช้งาน

### โครงสร้างไฟล์
```
├── server.js          ← ไฟล์หลัก
├── package.json
├── public/            ← Frontend
│   ├── index.html
│   └── app.js
└── data/              ← ข้อมูลโมเดล + ลิงก์
    ├── models-seed.json
    ├── ai-products.json
    └── ...
```
