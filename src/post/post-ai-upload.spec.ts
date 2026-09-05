import { PostService } from './post.service';
import { PrismaService } from '@/database/prisma.service';
import { CloudinaryService } from '@/infrastructure/upload/cloudinary.service';
import { FlyerService } from '@/flyer/flyer.service';
import { AiMatchingService } from '@/ai/ai-matching.service';
import { EmbeddingService } from '@/ai/service/embedding.service';
import { PostEventsService } from '@/post-events/post-events.service';

/** ตรวจว่าความล้มเหลวของ AI ไม่ทำให้รูปที่บันทึกแล้วถูกแจ้งว่าอัปโหลดล้มเหลว */
describe('Post AI upload', () => {
  const image = { id: 'image-1', imageUrl: 'https://example.com/pet.png' };
  const prisma = {
    petPost: { findFirst: jest.fn().mockResolvedValue({ id: 'post-1' }) },
    postImage: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue(image),
    },
    $transaction: jest.fn().mockResolvedValue([image]),
  };
  const embedding = { createImageEmbedding: jest.fn() };
  const matching = { matchPost: jest.fn() };
  const cloudinary = { upload: jest.fn().mockResolvedValue(image.imageUrl) };
  const service = new PostService(
    prisma as unknown as PrismaService,
    cloudinary as unknown as CloudinaryService,
    {} as FlyerService,
    matching as unknown as AiMatchingService,
    embedding as unknown as EmbeddingService,
    {} as PostEventsService,
  );
  const file = { mimetype: 'image/png', size: 100 } as Express.Multer.File;
  beforeEach(() => {
    jest.clearAllMocks();
  });
  it('returns saved images and a warning when embedding fails', async () => {
    embedding.createImageEmbedding.mockRejectedValueOnce(
      new Error('unavailable'),
    );
    const result = await service.uploadPostImages('post-1', 'owner-1', [file]);
    expect(result.images).toEqual([image]);
    expect(result.matching).toBeNull();
    expect(result.aiWarning).toContain('บันทึกรูปภาพแล้ว');
    expect(matching.matchPost).not.toHaveBeenCalled();
  });
  it('does not report an AI warning after successful matching', async () => {
    embedding.createImageEmbedding.mockResolvedValueOnce(undefined);
    matching.matchPost.mockResolvedValueOnce({ totalMatches: 0 });
    const result = await service.uploadPostImages('post-1', 'owner-1', [file]);
    expect(result.matching).toEqual({ totalMatches: 0 });
    expect(result.aiWarning).toBeUndefined();
  });
});
