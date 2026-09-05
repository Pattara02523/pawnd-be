import { ServiceUnavailableException } from '@nestjs/common';

/** จำกัดการเรียก AI ตามงบฟรีของ PAWND และห้ามเลือกโมเดลเสียเงินโดยผิดพลาด */
export function assertFreeAiModel(model: string): void {
  if (model !== 'openrouter/free' && !model.endsWith(':free')) {
    throw new ServiceUnavailableException(
      'ระบบ AI รองรับเฉพาะโมเดลฟรี กรุณาติดต่อผู้ดูแล',
    );
  }
}

/** จำกัดทั้งราคา token, ต่อคำขอ และต่อรูป ไม่ fallback ไป provider ที่คิดเงิน */
export const FREE_AI_PROVIDER = {
  max_price: { prompt: 0, completion: 0, request: 0, image: 0 },
};
