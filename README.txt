MeetCast AI v3.0 — Upload Fix

แก้ปัญหา:
Unexpected token '<', "<html>..." is not valid JSON

ปรับปรุง:
- ตรวจ Backend ก่อนแนบไฟล์ทุกครั้ง
- API Upload ตอบ Error เป็น JSON เสมอ
- ถ้าเปิด app/index.html โดยตรง จะแจ้งให้เปิด MeetCastAI.exe แทน
- ถ้าได้ HTML/404 จาก Backend จะแสดงสาเหตุภาษาไทยแทน JSON error
- เพิ่ม server identity ใน /api/health
- เก็บ log ฝั่ง Backend สำหรับวิเคราะห์ปัญหา
- ระบบแนบไฟล์ทุกนามสกุล + OCR จาก v2.9 ยังอยู่ครบ

วิธีใช้:
ดับเบิลคลิก MeetCastAI.exe และใช้หน้าเว็บที่โปรแกรมเปิดให้อัตโนมัติ
อย่าเปิดไฟล์ app-source/index.html โดยตรง
