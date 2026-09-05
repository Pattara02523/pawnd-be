import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { AiService } from './ai.service';
import { OpenRouterProvider } from './providers/openrouter.provider';
import { AiLogService } from './service/ai-log.service';
import { EmbeddingService } from './service/embedding.service';
import { PetAvatarService } from './service/pet-avatar.service';
import { PrismaService } from '@/database/prisma.service';
import { CloudinaryService } from '@/infrastructure/upload/cloudinary.service';
import { assertFreeAiModel } from './free-ai-policy';

/** ทดสอบขอบเขตงบฟรีและคำตอบ provider โดยไม่ใช้ key หรือส่งคำขอภายนอก */
describe('Free AI integration', () => {
  const config = (values: Record<string, unknown>) => new ConfigService(values);
  const create = jest.fn();
  const log = { createAiLog: jest.fn().mockResolvedValue({}) };
  const provider = { getClient: () => ({ chat: { completions: { create } } }) };
  const analysis = {
    type: 'BIRD',
    breed: null,
    color: 'สีเขียว',
    distinctiveFeatures: null,
    description: 'นกสีเขียว',
  };
  const service = (model = 'openrouter/free') =>
    new AiService(
      provider as unknown as OpenRouterProvider,
      config({
        AI_MOCK_MODE: false,
        AI_ANALYZE_IMAGE_MODEL: model,
        AI_ANALYZE_IMAGE_MODEL_FREE: 'openrouter/free',
      }),
      log as unknown as AiLogService,
    );
  beforeEach(() => {
    jest.clearAllMocks();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects paid model identifiers', () => {
    expect(() => assertFreeAiModel('paid/model')).toThrow(
      ServiceUnavailableException,
    );
    expect(() => assertFreeAiModel('openrouter/free')).not.toThrow();
    expect(() => assertFreeAiModel('nvidia/model:free')).not.toThrow();
  });
  it('never calls the provider for a paid analysis model', async () => {
    await expect(
      service('paid/model').analyzeImage('https://example.com/pet.png'),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(create).not.toHaveBeenCalled();
  });
  it('accepts non-dog/cat species and requests zero-cost structured output', async () => {
    create.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(analysis) } }],
    });
    await expect(
      service().analyzeImage('https://example.com/pet.png'),
    ).resolves.toEqual(analysis);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: {
          require_parameters: true,
          max_price: { prompt: 0, completion: 0, request: 0, image: 0 },
        },
      }),
    );
  });
  it('rejects malformed model fields', async () => {
    create.mockResolvedValue({
      choices: [
        { message: { content: JSON.stringify({ ...analysis, breed: 123 }) } },
      ],
    });
    await expect(
      service().analyzeImage('https://example.com/pet.png'),
    ).rejects.toThrow(ServiceUnavailableException);
  });
  it('falls back on 429 only to the configured free model', async () => {
    create
      .mockRejectedValueOnce(
        Object.assign(new Error('rate limit'), { status: 429 }),
      )
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify(analysis) } }],
      });
    await expect(
      service('example/model:free').analyzeImage('https://example.com/pet.png'),
    ).resolves.toEqual(analysis);
    expect(create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ model: 'openrouter/free' }),
    );
  });
  it('blocks real avatars before quota, database and provider work', async () => {
    const prisma = { pet: { findUnique: jest.fn() } };
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    const avatar = new PetAvatarService(
      prisma as unknown as PrismaService,
      config({ AI_MOCK_MODE: false }),
      {} as CloudinaryService,
    );
    await expect(
      avatar.generatePetAvatar({ petId: 'pet', imageUrls: [] }, 'owner'),
    ).rejects.toThrow('โหมด AI ฟรี');
    expect(prisma.pet.findUnique).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects wrong embedding dimensions instead of storing invalid vectors', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: [1, 2] }] }), {
        status: 200,
      }),
    );
    const embedding = new EmbeddingService(
      {} as PrismaService,
      config({
        AI_MOCK_MODE: false,
        AI_IMAGE_EMBEDDING_MODEL: 'nvidia/model:free',
        AI_IMAGE_EMBEDDING_DIMENSION: 768,
        OPENROUTER_API_KEY: 'test-only',
      }),
    );
    await expect(
      embedding.generateEmbeddingFromImageSource('https://example.com/pet.png'),
    ).rejects.toThrow('Invalid embedding dimension');
  });
  it('stores real embeddings in a namespace isolated from old and mock rows', async () => {
    const prisma = {
      postImage: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ imageUrl: 'https://example.com/pet.png' }),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ data: [{ embedding: Array(768).fill(0.1) }] }),
          { status: 200 },
        ),
      );
    const embedding = new EmbeddingService(
      prisma as unknown as PrismaService,
      config({
        AI_MOCK_MODE: false,
        AI_IMAGE_EMBEDDING_MODEL: 'nvidia/model:free',
        AI_IMAGE_EMBEDDING_DIMENSION: 768,
        OPENROUTER_API_KEY: 'test-only',
      }),
    );
    await embedding.createImageEmbedding('image');
    expect(prisma.$executeRaw.mock.calls[0]).toContain(
      'live-v2:nvidia/model:free:768',
    );
  });
});
