import { AiService } from '@/ai/ai.service';
import { EmbeddingService } from '@/ai/service/embedding.service';
import type {
  AiMatch,
  PetPost,
  PostImage,
} from '@/database/generated/prisma/client';
import {
  PostEventType,
  PostStatus,
  PostType,
} from '@/database/generated/prisma/enums';
import { PrismaService } from '@/database/prisma.service';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PostEventsService } from '@/post-events/post-events.service';

type PendingAiMatch = {
  lostPostId: string;
  foundPostId: string;
  vectorSimilarity: number;
  featureScore: number;
  locationScore: number;
  dateScore: number;
  finalScore: number;
  distanceKm: number;
};

@Injectable()
export class AiMatchingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddingService: EmbeddingService,
    private readonly postEventsService: PostEventsService,
    private readonly aiService: AiService,
  ) {}

  async matchPost(userId: string, postId: string) {
    // 1. หา post ต้นทาง
    const sourcePost = await this.prisma.petPost.findFirst({
      where: {
        id: postId,
        userId,
        status: PostStatus.ACTIVE,
      },
      include: {
        images: true,
      },
    });

    if (!sourcePost) {
      throw new NotFoundException('Post not found');
    }

    // 2. Match ได้เฉพาะ post ที่ ACTIVE
    if (sourcePost.status !== PostStatus.ACTIVE) {
      throw new BadRequestException('Only active posts can be matched');
    }

    // เมื่อผู้ใช้กดจับคู่ใหม่ ให้สร้าง embedding ที่ขาดของประกาศนี้ก่อน (เช่น provider เคยล่ม)
    for (const image of sourcePost.images) {
      await this.embeddingService.createImageEmbedding(image.id);
    }

    // 3. LOST ต้องหา FOUND / FOUND ต้องหา LOST
    const oppositeType =
      sourcePost.type === PostType.LOST ? PostType.FOUND : PostType.LOST;

    // 4. หา candidate
    const candidates = await this.prisma.petPost.findMany({
      where: {
        id: {
          not: sourcePost.id,
        },

        type: oppositeType,

        status: PostStatus.ACTIVE,

        // อย่างน้อยต้องเป็นสัตว์ประเภทเดียวกัน
        petType: sourcePost.petType,
      },

      include: {
        images: true,
      },
    });

    const pendingMatches: PendingAiMatch[] = [];

    // 5. คำนวณคะแนน candidate แต่ละตัว
    for (const candidate of candidates) {
      const vectorSimilarity = await this.calculateVectorSimilarity(
        sourcePost.id,
        candidate.id,
      );

      const featureScore = this.calculateFeatureScore(sourcePost, candidate);

      const { score: locationScore, distanceKm } = this.calculateLocationScore(
        Number(sourcePost.latitude),
        Number(sourcePost.longitude),
        Number(candidate.latitude),
        Number(candidate.longitude),
      );

      const dateScore = this.calculateDateScore(
        sourcePost.eventDate,
        candidate.eventDate,
      );

      const finalScore = this.calculateFinalScore({
        vectorSimilarity,
        featureScore,
        locationScore,
        dateScore,
      });

      // Match threshold รอบแรก 50%
      if (finalScore < 0.5) {
        continue;
      }

      // ai_matches บังคับให้รู้ว่าอันไหน LOST / FOUND
      const lostPostId =
        sourcePost.type === PostType.LOST ? sourcePost.id : candidate.id;

      const foundPostId =
        sourcePost.type === PostType.FOUND ? sourcePost.id : candidate.id;

      pendingMatches.push({
        lostPostId,
        foundPostId,
        vectorSimilarity,
        featureScore,
        locationScore,
        dateScore,
        finalScore,
        distanceKm,
      });
    }

    const results: AiMatch[] =
      pendingMatches.length === 0
        ? []
        : await this.prisma.$transaction(async (tx) => {
            const persistedMatches: AiMatch[] = [];

            for (const pendingMatch of pendingMatches) {
              const match = await tx.aiMatch.upsert({
                where: {
                  lostPostId_foundPostId: {
                    lostPostId: pendingMatch.lostPostId,
                    foundPostId: pendingMatch.foundPostId,
                  },
                },

                create: {
                  lostPostId: pendingMatch.lostPostId,
                  foundPostId: pendingMatch.foundPostId,

                  vectorSimilarity: pendingMatch.vectorSimilarity,
                  featureScore: pendingMatch.featureScore,
                  locationScore: pendingMatch.locationScore,
                  dateScore: pendingMatch.dateScore,

                  finalScore: pendingMatch.finalScore,
                  distanceKm: pendingMatch.distanceKm,

                  modelName: 'PAWND_MATCHING_V2',
                  modelVersion: '2.0',
                },

                update: {
                  vectorSimilarity: pendingMatch.vectorSimilarity,
                  featureScore: pendingMatch.featureScore,
                  locationScore: pendingMatch.locationScore,
                  dateScore: pendingMatch.dateScore,

                  finalScore: pendingMatch.finalScore,
                  distanceKm: pendingMatch.distanceKm,

                  modelName: 'PAWND_MATCHING_V2',
                  modelVersion: '2.0',
                },
              });

              persistedMatches.push(match);
            }

            const existingEvent = await tx.postEvent.findFirst({
              where: {
                postId,
                eventType: PostEventType.AI_MATCHES_FOUND,
              },
              select: { id: true },
            });

            if (!existingEvent) {
              await this.postEventsService.recordEvent(tx, {
                postId,
                eventType: PostEventType.AI_MATCHES_FOUND,
                createdBy: null,
              });
            }

            return persistedMatches;
          });

    // 7. เรียง match จากคะแนนสูง → ต่ำ
    results.sort((a, b) => Number(b.finalScore) - Number(a.finalScore));

    return {
      postId,
      totalCandidates: candidates.length,
      totalMatches: results.length,
      matches: results,
    };
  }

  // =========================================================
  // STANDALONE IMAGE SEARCH (no source PetPost required)
  // =========================================================

  async matchByImage(
    file: Express.Multer.File,
    options: { limit: number; postType?: PostType },
  ) {
    if (!file) {
      throw new BadRequestException('Image file is required');
    }

    const imageDataUrl = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;

    // Reuse the same AI vision analysis used for post images, so feature
    // scoring compares against the same breed/color/distinctiveFeatures
    // vocabulary already stored on PetPost.
    const analysis = await this.aiService.analyzeImage(imageDataUrl);

    // Reuse the same embedding model/dimension as stored PostImage
    // embeddings so the query vector lives in the same vector space.
    const { embedding, model } =
      await this.embeddingService.generateEmbeddingFromImageSource(
        imageDataUrl,
      );

    // Retrieve a wider vector-similarity pool than the requested limit so it
    // can be re-ranked with featureScore before truncating to `limit`.
    const poolSize = Math.min(Math.max(options.limit * 5, 30), 100);

    const vectorCandidates = await this.embeddingService.findSimilarPosts(
      embedding,
      model,
      {
        limit: poolSize,
        postType: options.postType,
        // Same hard filter matchPost() applies to candidates: at minimum
        // the pet type must match.
        petType: analysis.type,
      },
    );

    if (vectorCandidates.length === 0) {
      return {
        totalCandidates: 0,
        totalMatches: 0,
        analysis,
        matches: [],
      };
    }

    const posts = await this.prisma.petPost.findMany({
      where: {
        id: { in: vectorCandidates.map((candidate) => candidate.postId) },
      },
      include: {
        images: {
          orderBy: { sortOrder: 'asc' },
        },
      },
    });

    const postsById = new Map(posts.map((post) => [post.id, post]));

    const matches = vectorCandidates
      .map((candidate) => {
        const post = postsById.get(candidate.postId);

        if (!post) {
          return null;
        }

        const featureScore = this.calculateFeatureScore(
          {
            breed: analysis.breed,
            color: analysis.color,
            distinctiveFeatures: analysis.distinctiveFeatures,
          },
          post,
        );

        // No source post exists yet, so location/date scores would have no
        // real input — they are intentionally left out instead of
        // fabricated. The persisted pipeline (PAWND_MATCHING_V2) weighs
        // vector/feature at 30/30 out of 100; renormalized over just these
        // two available signals that becomes an even 50/50 split.
        const finalScore = this.clamp(
          candidate.vectorSimilarity * 0.5 + featureScore * 0.5,
        );

        return {
          postId: post.id,
          vectorSimilarity: candidate.vectorSimilarity,
          featureScore,
          finalScore,
          post: this.toSearchPostResult(post),
        };
      })
      .filter((match): match is NonNullable<typeof match> => match !== null)
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, options.limit);

    return {
      totalCandidates: vectorCandidates.length,
      totalMatches: matches.length,
      analysis,
      matches,
    };
  }

  private toSearchPostResult(post: PetPost & { images: PostImage[] }) {
    return {
      id: post.id,
      type: post.type,
      status: post.status,

      petName: post.petName,
      petType: post.petType,

      breed: post.breed,
      gender: post.gender,
      color: post.color,

      distinctiveFeatures: post.distinctiveFeatures,
      description: post.description,

      eventDate: post.eventDate,

      latitude: post.latitude,
      longitude: post.longitude,
      province: post.province,
      district: post.district,
      subdistrict: post.subdistrict,
      locationDescription: post.locationDescription,

      createdAt: post.createdAt,

      images: post.images.map((image) => ({
        id: image.id,
        imageUrl: image.imageUrl,
        sortOrder: image.sortOrder,
      })),
    };
  }

  private async assertOwnedPost(userId: string, postId: string) {
    const post = await this.prisma.petPost.findFirst({
      where: {
        id: postId,
        userId,
        status: { not: PostStatus.DELETED },
      },
      select: { id: true },
    });

    if (!post) {
      throw new NotFoundException('Post not found or you do not own this post');
    }

    return post;
  }

  // เป็น public endpoint อ่านได้ทุกคนแม้ไม่ login (ไม่มี personalization ต่อ user — pin/dismiss
  // เป็น per-post action ที่แชร์กันทุกคนที่ดู) สิทธิ์แก้ไข Pin/Dismiss/สั่งจับคู่ใหม่
  // ยังคงจำกัดเฉพาะเจ้าของผ่าน assertOwnedPost ใน togglePinMatch/toggleDismissMatch/matchPost
  async getPostMatches(postId: string) {
    const post = await this.prisma.petPost.findUnique({
      where: {
        id: postId,
      },
    });

    if (!post) {
      throw new NotFoundException('Post not found');
    }

    const matches = await this.prisma.aiMatch.findMany({
      where: {
        OR: [{ lostPostId: postId }, { foundPostId: postId }],
      },

      include: {
        lostPost: {
          include: {
            images: true,
          },
        },

        foundPost: {
          include: {
            images: true,
          },
        },

        // เอาสถานะ pin/dismiss ของ "post นี้" มาด้วย (per-post action)
        aiMatchUserActions: {
          where: { postId },
        },
      },

      orderBy: {
        finalScore: 'desc',
      },
    });

    const results = matches.map((match) => {
      const matchedPost =
        match.lostPostId === postId ? match.foundPost : match.lostPost;

      const userAction = match.aiMatchUserActions[0];

      return {
        matchId: match.id,

        matchedPost,

        scores: {
          vectorSimilarity: match.vectorSimilarity,
          featureScore: match.featureScore,
          locationScore: match.locationScore,
          dateScore: match.dateScore,
          finalScore: match.finalScore,
          distanceKm: match.distanceKm,
        },

        isNotified: match.isNotified,
        isPinned: userAction?.isPinned ?? false,
        isDismissed: userAction?.isDismissed ?? false,
        createdAt: match.createdAt,
        updatedAt: match.updatedAt,
      };
    });

    return {
      postId,
      totalMatches: results.length,
      matches: results,
    };
  }

  async getMatchDetail(matchId: string) {
    const match = await this.prisma.aiMatch.findUnique({
      where: {
        id: matchId,
      },

      include: {
        lostPost: {
          include: {
            images: {
              orderBy: {
                sortOrder: 'asc',
              },
            },
          },
        },

        foundPost: {
          include: {
            images: {
              orderBy: {
                sortOrder: 'asc',
              },
            },
          },
        },
      },
    });

    if (!match) {
      throw new NotFoundException('AI match not found');
    }

    return {
      matchId: match.id,

      lostPost: {
        id: match.lostPost.id,
        type: match.lostPost.type,
        status: match.lostPost.status,

        petName: match.lostPost.petName,
        petType: match.lostPost.petType,

        breed: match.lostPost.breed,
        gender: match.lostPost.gender,
        color: match.lostPost.color,

        distinctiveFeatures: match.lostPost.distinctiveFeatures,

        description: match.lostPost.description,

        eventDate: match.lostPost.eventDate,

        latitude: match.lostPost.latitude,

        longitude: match.lostPost.longitude,

        province: match.lostPost.province,

        district: match.lostPost.district,

        subdistrict: match.lostPost.subdistrict,

        locationDescription: match.lostPost.locationDescription,

        images: match.lostPost.images.map((image) => ({
          id: image.id,
          imageUrl: image.imageUrl,
          sortOrder: image.sortOrder,
        })),
      },

      foundPost: {
        id: match.foundPost.id,
        type: match.foundPost.type,
        status: match.foundPost.status,

        petName: match.foundPost.petName,
        petType: match.foundPost.petType,

        breed: match.foundPost.breed,
        gender: match.foundPost.gender,
        color: match.foundPost.color,

        distinctiveFeatures: match.foundPost.distinctiveFeatures,

        description: match.foundPost.description,

        eventDate: match.foundPost.eventDate,

        latitude: match.foundPost.latitude,

        longitude: match.foundPost.longitude,

        province: match.foundPost.province,

        district: match.foundPost.district,

        subdistrict: match.foundPost.subdistrict,

        locationDescription: match.foundPost.locationDescription,

        images: match.foundPost.images.map((image) => ({
          id: image.id,
          imageUrl: image.imageUrl,
          sortOrder: image.sortOrder,
        })),
      },

      scores: {
        vectorSimilarity: match.vectorSimilarity,

        featureScore: match.featureScore,

        locationScore: match.locationScore,

        dateScore: match.dateScore,

        finalScore: match.finalScore,

        distanceKm: match.distanceKm,
      },

      model: {
        name: match.modelName,
        version: match.modelVersion,
      },

      isNotified: match.isNotified,

      createdAt: match.createdAt,

      updatedAt: match.updatedAt,
    };
  }

  async togglePinMatch(userId: string, postId: string, matchId: string) {
    const post = await this.assertOwnedPost(userId, postId);

    if (!post) {
      throw new NotFoundException('Post not found');
    }

    const match = await this.prisma.aiMatch.findUnique({
      where: {
        id: matchId,
      },
    });

    if (!match) {
      throw new NotFoundException('AI match not found');
    }

    const belongsToMatch =
      match.lostPostId === postId || match.foundPostId === postId;

    if (!belongsToMatch) {
      throw new BadRequestException(
        'This match does not belong to the specified post',
      );
    }

    const existingAction = await this.prisma.aiMatchUserAction.findUnique({
      where: {
        matchId_postId: {
          matchId,
          postId,
        },
      },
    });

    const nextPinned = !(existingAction?.isPinned ?? false);

    const action = await this.prisma.aiMatchUserAction.upsert({
      where: {
        matchId_postId: {
          matchId,
          postId,
        },
      },

      create: {
        matchId,
        postId,
        isPinned: nextPinned,
        isDismissed: false,
      },

      update: {
        isPinned: nextPinned,

        // ถ้ากลับมา pin
        // ให้ยกเลิก dismissed ด้วย
        ...(nextPinned
          ? {
              isDismissed: false,
            }
          : {}),
      },
    });

    return {
      matchId,
      postId,
      isPinned: action.isPinned,
      isDismissed: action.isDismissed,
    };
  }

  async toggleDismissMatch(userId: string, postId: string, matchId: string) {
    const post = await this.assertOwnedPost(userId, postId);

    if (!post) {
      throw new NotFoundException('Post not found');
    }

    const match = await this.prisma.aiMatch.findUnique({
      where: {
        id: matchId,
      },
    });

    if (!match) {
      throw new NotFoundException('AI match not found');
    }

    const belongsToMatch =
      match.lostPostId === postId || match.foundPostId === postId;

    if (!belongsToMatch) {
      throw new BadRequestException(
        'This match does not belong to the specified post',
      );
    }

    const existingAction = await this.prisma.aiMatchUserAction.findUnique({
      where: {
        matchId_postId: {
          matchId,
          postId,
        },
      },
    });

    const nextDismissed = !(existingAction?.isDismissed ?? false);

    const action = await this.prisma.aiMatchUserAction.upsert({
      where: {
        matchId_postId: {
          matchId,
          postId,
        },
      },

      create: {
        matchId,
        postId,

        isPinned: false,
        isDismissed: nextDismissed,
      },

      update: {
        isDismissed: nextDismissed,

        // ถ้า dismiss match
        // ให้เอา pin ออกด้วย
        ...(nextDismissed
          ? {
              isPinned: false,
            }
          : {}),
      },
    });

    return {
      matchId,
      postId,

      isPinned: action.isPinned,
      isDismissed: action.isDismissed,
    };
  }

  // =========================================================
  // VECTOR SIMILARITY
  // =========================================================

  private async calculateVectorSimilarity(
    sourcePostId: string,
    candidatePostId: string,
  ): Promise<number> {
    return this.embeddingService.calculatePostSimilarity(
      sourcePostId,
      candidatePostId,
    );
  }

  // =========================================================
  // FEATURE SCORE
  // =========================================================

  private calculateFeatureScore(
    source: {
      breed: string | null;
      color: string | null;
      distinctiveFeatures: string | null;
    },

    candidate: {
      breed: string | null;
      color: string | null;
      distinctiveFeatures: string | null;
    },
  ): number {
    let score = 0;
    let weight = 0;

    // -------------------------
    // Breed = 35%
    // -------------------------

    if (source.breed && candidate.breed) {
      weight += 0.35;

      if (this.normalize(source.breed) === this.normalize(candidate.breed)) {
        score += 0.35;
      }
    }

    // -------------------------
    // Color = 35%
    // -------------------------

    if (source.color && candidate.color) {
      weight += 0.35;

      if (this.hasTextOverlap(source.color, candidate.color)) {
        score += 0.35;
      }
    }

    // -------------------------
    // Distinctive Features = 30%
    // -------------------------

    if (source.distinctiveFeatures && candidate.distinctiveFeatures) {
      weight += 0.3;

      if (
        this.hasTextOverlap(
          source.distinctiveFeatures,
          candidate.distinctiveFeatures,
        )
      ) {
        score += 0.3;
      }
    }

    // ไม่มี feature สำหรับเทียบเลย
    if (weight === 0) {
      return 0;
    }

    /*
     * Normalize ตามข้อมูลที่มีจริง
     *
     * ตัวอย่าง:
     * มีแค่ breed และ color
     * weight = 0.70
     *
     * ถ้าตรงทั้งหมด:
     * score = 0.70
     *
     * 0.70 / 0.70 = 1
     */
    return this.clamp(score / weight);
  }

  // =========================================================
  // LOCATION SCORE
  // =========================================================

  private calculateLocationScore(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): {
    score: number;
    distanceKm: number;
  } {
    const distanceKm = this.calculateDistanceKm(lat1, lon1, lat2, lon2);

    let score: number;

    if (distanceKm <= 1) {
      score = 1;
    } else if (distanceKm <= 3) {
      score = 0.9;
    } else if (distanceKm <= 5) {
      score = 0.8;
    } else if (distanceKm <= 10) {
      score = 0.6;
    } else if (distanceKm <= 20) {
      score = 0.3;
    } else {
      score = 0.1;
    }

    return {
      score,
      distanceKm,
    };
  }

  // =========================================================
  // DATE SCORE
  // =========================================================

  private calculateDateScore(sourceDate: Date, candidateDate: Date): number {
    const milliseconds = Math.abs(
      sourceDate.getTime() - candidateDate.getTime(),
    );

    const days = milliseconds / (1000 * 60 * 60 * 24);

    if (days <= 1) {
      return 1;
    }

    if (days <= 3) {
      return 0.9;
    }

    if (days <= 7) {
      return 0.7;
    }

    if (days <= 14) {
      return 0.5;
    }

    if (days <= 30) {
      return 0.3;
    }

    return 0.1;
  }

  // =========================================================
  // FINAL SCORE
  // =========================================================

  private calculateFinalScore(input: {
    vectorSimilarity: number;
    featureScore: number;
    locationScore: number;
    dateScore: number;
  }): number {
    /**
     * Weight V1
     *
     * Vector Similarity = 50%
     * Feature           = 20%
     * Location          = 20%
     * Date              = 10%
     */

    // const score =
    //   input.vectorSimilarity * 0.5 +
    //   input.featureScore * 0.2 +
    //   input.locationScore * 0.2 +
    //   input.dateScore * 0.1;

    /**
     * Weight V2
     *
     * Vector   30%
     * Feature  30%
     * Location 25%
     * Date     15%
     */

    const score =
      input.vectorSimilarity * 0.3 +
      input.featureScore * 0.3 +
      input.locationScore * 0.25 +
      input.dateScore * 0.15;

    return this.clamp(score);
  }

  // =========================================================
  // HAVERSINE DISTANCE
  // =========================================================

  private calculateDistanceKm(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const earthRadiusKm = 6371;

    const dLat = this.toRadians(lat2 - lat1);

    const dLon = this.toRadians(lon2 - lon1);

    const latitude1 = this.toRadians(lat1);

    const latitude2 = this.toRadians(lat2);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(latitude1) *
        Math.cos(latitude2) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return earthRadiusKm * c;
  }

  private toRadians(degree: number): number {
    return degree * (Math.PI / 180);
  }

  // =========================================================
  // TEXT HELPERS
  // =========================================================

  private normalize(value: string): string {
    return value.trim().toLowerCase();
  }

  private hasTextOverlap(value1: string, value2: string): boolean {
    const first = this.normalize(value1);
    const second = this.normalize(value2);

    // ถ้าข้อความหนึ่งอยู่ในอีกข้อความหนึ่ง
    if (first.includes(second) || second.includes(first)) {
      return true;
    }

    const words1 = new Set(first.split(/\s+/));

    const words2 = new Set(second.split(/\s+/));

    for (const word of words1) {
      if (word.length >= 3 && words2.has(word)) {
        return true;
      }
    }

    return false;
  }

  // =========================================================
  // SCORE HELPER
  // =========================================================

  private clamp(value: number): number {
    return Math.max(0, Math.min(1, value));
  }
}
