/// <reference types="jest" />

import { BadRequestException, NotFoundException } from '@nestjs/common';

import { AiMatchingService } from './ai-matching.service';
import type { AiService } from './ai.service';
import type { EmbeddingService } from './service/embedding.service';
import type { PostEventsService } from '@/post-events/post-events.service';
import type { PrismaService } from '@/database/prisma.service';
import {
  PetType,
  PostEventType,
  PostStatus,
  PostType,
} from '@/database/generated/prisma/enums';

const postId = '00000000-0000-4000-8000-000000000001';
const candidateId = '00000000-0000-4000-8000-000000000002';
const matchId = '00000000-0000-4000-8000-000000000003';
const ownerId = '00000000-0000-4000-8000-000000000004';
const otherUserId = '00000000-0000-4000-8000-000000000005';

const createPost = (id: string, userId: string, type: PostType) => ({
  id,
  userId,
  type,
  status: PostStatus.ACTIVE,
  petType: PetType.DOG,
  breed: 'Labrador',
  color: 'black',
  distinctiveFeatures: 'white paw',
  eventDate: new Date('2026-08-20T00:00:00.000Z'),
  latitude: 13.7563,
  longitude: 100.5018,
  images: [],
});

describe('AiMatchingService', () => {
  const prismaMock = {
    petPost: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    aiMatch: {
      findUnique: jest.fn(),
    },
    aiMatchUserAction: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const transactionClient = {
    aiMatch: {
      upsert: jest.fn(),
    },
    postEvent: {
      findFirst: jest.fn(),
    },
  };
  const embeddingMock = {
    calculatePostSimilarity: jest.fn(),
    createImageEmbedding: jest.fn(),
  };
  const postEventsMock = {
    recordEvent: jest.fn(),
  };
  const aiServiceMock = {
    analyzeImage: jest.fn(),
  };

  let service: AiMatchingService;

  beforeEach(() => {
    jest.resetAllMocks();

    const sourcePost = createPost(postId, ownerId, PostType.LOST);
    const candidatePost = createPost(candidateId, otherUserId, PostType.FOUND);
    const persistedMatch = {
      id: matchId,
      lostPostId: postId,
      foundPostId: candidateId,
      finalScore: 1,
    };

    prismaMock.petPost.findUnique.mockResolvedValue(sourcePost);
    prismaMock.petPost.findFirst.mockResolvedValue(sourcePost);
    prismaMock.petPost.findMany.mockResolvedValue([candidatePost]);
    embeddingMock.calculatePostSimilarity.mockResolvedValue(1);
    transactionClient.aiMatch.upsert.mockResolvedValue(persistedMatch);
    transactionClient.postEvent.findFirst.mockResolvedValue(null);
    postEventsMock.recordEvent.mockResolvedValue({ id: 'event-id' });
    prismaMock.$transaction.mockImplementation(
      async (
        callback: (client: typeof transactionClient) => Promise<unknown>,
      ) => callback(transactionClient),
    );

    service = new AiMatchingService(
      prismaMock as unknown as PrismaService,
      embeddingMock as unknown as EmbeddingService,
      postEventsMock as unknown as PostEventsService,
      aiServiceMock as unknown as AiService,
    );
  });

  describe('matchPost', () => {
    // กดจับคู่ใหม่ต้องซ่อม embedding ของประกาศที่เคยล้มเหลวก่อนคำนวณคะแนน
    it('retries missing source embeddings before matching', async () => {
      prismaMock.petPost.findFirst.mockResolvedValueOnce({
        ...createPost(postId, ownerId, PostType.LOST),
        images: [{ id: 'image-1' }],
      });
      await service.matchPost(ownerId, postId);
      expect(embeddingMock.createImageEmbedding).toHaveBeenCalledWith(
        'image-1',
      );
    });
    it('persists matches and the first AI_MATCHES_FOUND event in one transaction', async () => {
      const result = await service.matchPost(ownerId, postId);

      expect(result.totalMatches).toBe(1);
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
      expect(transactionClient.aiMatch.upsert).toHaveBeenCalledTimes(1);
      expect(transactionClient.postEvent.findFirst).toHaveBeenCalledWith({
        where: {
          postId,
          eventType: PostEventType.AI_MATCHES_FOUND,
        },
        select: { id: true },
      });
      expect(postEventsMock.recordEvent).toHaveBeenCalledWith(
        transactionClient,
        {
          postId,
          eventType: PostEventType.AI_MATCHES_FOUND,
          createdBy: null,
        },
      );
    });

    it('does not create a timeline event when no candidate produces a result', async () => {
      prismaMock.petPost.findMany.mockResolvedValue([]);

      const result = await service.matchPost(ownerId, postId);

      expect(result.totalMatches).toBe(0);
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
      expect(postEventsMock.recordEvent).not.toHaveBeenCalled();
    });

    it('does not create AI_MATCHES_FOUND again when processing is retried', async () => {
      transactionClient.postEvent.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'event-id' });

      await service.matchPost(ownerId, postId);
      await service.matchPost(ownerId, postId);

      expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
      expect(transactionClient.aiMatch.upsert).toHaveBeenCalledTimes(2);
      expect(postEventsMock.recordEvent).toHaveBeenCalledTimes(1);
    });

    it('propagates event persistence failure so the transaction can roll back the match', async () => {
      const databaseError = new Error('event persistence failed');
      postEventsMock.recordEvent.mockRejectedValue(databaseError);

      await expect(service.matchPost(ownerId, postId)).rejects.toBe(
        databaseError,
      );
      expect(transactionClient.aiMatch.upsert).toHaveBeenCalledTimes(1);
      expect(postEventsMock.recordEvent).toHaveBeenCalledTimes(1);
    });
  });

  describe('togglePinMatch', () => {
    beforeEach(() => {
      prismaMock.petPost.findUnique.mockResolvedValue({
        id: postId,
        userId: ownerId,
      });
      prismaMock.aiMatch.findUnique.mockResolvedValue({
        id: matchId,
        lostPostId: postId,
        foundPostId: candidateId,
      });
      prismaMock.aiMatchUserAction.findUnique.mockResolvedValue(null);
      prismaMock.aiMatchUserAction.upsert.mockResolvedValue({
        isPinned: true,
        isDismissed: false,
      });
    });

    it('allows the post owner to pin a match using the existing action upsert', async () => {
      await expect(
        service.togglePinMatch(ownerId, postId, matchId),
      ).resolves.toEqual({
        matchId,
        postId,
        isPinned: true,
        isDismissed: false,
      });

      expect(prismaMock.aiMatchUserAction.upsert).toHaveBeenCalledWith({
        where: {
          matchId_postId: {
            matchId,
            postId,
          },
        },
        create: {
          matchId,
          postId,
          isPinned: true,
          isDismissed: false,
        },
        update: {
          isPinned: true,
          isDismissed: false,
        },
      });
      expect(postEventsMock.recordEvent).not.toHaveBeenCalled();
    });

    it('rejects a non-owner before changing the match action', async () => {
      prismaMock.petPost.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.togglePinMatch(otherUserId, postId, matchId),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prismaMock.aiMatch.findUnique).not.toHaveBeenCalled();
      expect(prismaMock.aiMatchUserAction.upsert).not.toHaveBeenCalled();
    });

    it('rejects a match that belongs to another post', async () => {
      prismaMock.aiMatch.findUnique.mockResolvedValue({
        id: matchId,
        lostPostId: '00000000-0000-4000-8000-000000000006',
        foundPostId: '00000000-0000-4000-8000-000000000007',
      });

      await expect(
        service.togglePinMatch(ownerId, postId, matchId),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prismaMock.aiMatchUserAction.upsert).not.toHaveBeenCalled();
    });
  });
});
