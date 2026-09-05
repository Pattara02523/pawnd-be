import { assertFreeAiModel, FREE_AI_PROVIDER } from '../free-ai-policy';
import { OpenRouterEmbeddingResponse } from '@/ai/types/openrouter-embedding.type';
import { createMockImageEmbedding } from '@/ai/mock-ai.data';
import { Prisma } from '@/database/generated/prisma/client';
import {
  PetType,
  PostStatus,
  PostType,
} from '@/database/generated/prisma/enums';
import { PrismaService } from '@/database/prisma.service';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class EmbeddingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async createImageEmbedding(postImageId: string): Promise<void> {
    const postImage = await this.prisma.postImage.findUnique({
      where: {
        id: postImageId,
      },
    });

    if (!postImage) {
      throw new NotFoundException('Post image not found');
    }

    const model = this.getEmbeddingModel();

    // เช็กก่อนว่าเคยสร้าง embedding ด้วย model แล้วไหม?
    const existingEmbedding = await this.prisma.$queryRaw<
      Array<{ id: string }>
    >`
      SELECT "id"
      FROM "image_embeddings"
      WHERE "post_image_id" = ${postImageId}::uuid
        AND "model_name" = ${this.storageModel(model)}
      LIMIT 1
    `;

    if (existingEmbedding.length > 0) {
      return;
    }

    const embedding = await this.generateImageEmbedding(
      postImage.imageUrl,
      model,
    );

    await this.saveEmbedding(postImageId, embedding, model);
  }

  private async generateImageEmbedding(
    imageUrl: string,
    model: string,
  ): Promise<number[]> {
    const dimension =
      this.configService.get<number>('AI_IMAGE_EMBEDDING_DIMENSION') ?? 768;

    if (this.isMockMode()) {
      return createMockImageEmbedding(imageUrl, dimension);
    }

    assertFreeAiModel(model);
    const baseUrl = 'https://openrouter.ai/api/v1';

    const apiKey = this.configService.getOrThrow<string>('OPENROUTER_API_KEY');

    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      signal: AbortSignal.timeout(30000),

      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },

      body: JSON.stringify({
        model,
        provider: FREE_AI_PROVIDER,

        input: [
          {
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: imageUrl,
                },
              },
            ],
          },
        ],

        dimensions: dimension,
        encoding_format: 'float',
      }),
    });

    if (!response.ok) {
      throw new BadRequestException(
        'AI เปรียบเทียบรูปยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง',
      );
    }

    const result = (await response.json()) as OpenRouterEmbeddingResponse;

    const embedding = result.data[0]?.embedding;

    if (
      !Array.isArray(embedding) ||
      !embedding.length ||
      embedding.some(
        (value) => typeof value !== 'number' || !Number.isFinite(value),
      )
    ) {
      throw new BadRequestException('Embedding model returned empty vector');
    }

    if (embedding.length !== dimension) {
      throw new BadRequestException(
        `Invalid embedding dimension: expected ${dimension}, received ${embedding.length}`,
      );
    }

    return embedding;
  }

  async calculatePostSimilarity(
    sourcePostId: string,
    candidatePostId: string,
  ): Promise<number> {
    const model = this.getEmbeddingModel();

    const rows = await this.prisma.$queryRaw<
      Array<{
        similarity: number | null;
      }>
    >`
      SELECT
        MAX(
          1 - (
            source_embedding."embedding"
            <=>
            candidate_embedding."embedding"
          )
        )::double precision AS "similarity"

      FROM "image_embeddings" source_embedding

      INNER JOIN "post_images" source_image
        ON source_image."id" =
           source_embedding."post_image_id"

      CROSS JOIN "image_embeddings" candidate_embedding

      INNER JOIN "post_images" candidate_image
        ON candidate_image."id" =
           candidate_embedding."post_image_id"

      WHERE source_image."post_id" =
            ${sourcePostId}::uuid

        AND candidate_image."post_id" =
            ${candidatePostId}::uuid

        AND source_embedding."model_name" =
            ${this.storageModel(model)}

        AND candidate_embedding."model_name" =
            ${this.storageModel(model)}
    `;

    return this.clamp(rows[0]?.similarity ?? 0);
  }

  /**
   * Generates an embedding from an arbitrary image source (URL or data URL)
   * without requiring a persisted PostImage row. Reuses the same model,
   * dimension, and provider call as `createImageEmbedding` so the resulting
   * vector lives in the same embedding space as stored post images.
   */
  async generateEmbeddingFromImageSource(
    imageSource: string,
  ): Promise<{ embedding: number[]; model: string }> {
    const model = this.getEmbeddingModel();

    const embedding = await this.generateImageEmbedding(imageSource, model);

    return { embedding, model };
  }

  /**
   * pgvector similarity search against stored image embeddings, aggregated
   * per post by taking the best-matching image (same MAX() strategy as
   * `calculatePostSimilarity`). Only ACTIVE posts are searchable.
   */
  async findSimilarPosts(
    embedding: number[],
    model: string,
    options: {
      limit: number;
      postType?: PostType;
      petType?: PetType;
    },
  ): Promise<Array<{ postId: string; vectorSimilarity: number }>> {
    const vector = `[${embedding.join(',')}]`;

    const postTypeFilter = options.postType
      ? Prisma.sql`AND pet_posts."type" = ${options.postType}::"post_type"`
      : Prisma.empty;

    const petTypeFilter = options.petType
      ? Prisma.sql`AND pet_posts."pet_type" = ${options.petType}::"pet_type"`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<
      Array<{ postId: string; similarity: number | null }>
    >(Prisma.sql`
      SELECT
        post_images."post_id" AS "postId",
        MAX(
          1 - (image_embeddings."embedding" <=> ${vector}::vector)
        )::double precision AS "similarity"

      FROM "image_embeddings" image_embeddings

      INNER JOIN "post_images" post_images
        ON post_images."id" = image_embeddings."post_image_id"

      INNER JOIN "pet_posts" pet_posts
        ON pet_posts."id" = post_images."post_id"

      WHERE image_embeddings."model_name" = ${this.storageModel(model)}
        AND pet_posts."status" = ${PostStatus.ACTIVE}::"post_status"
        ${postTypeFilter}
        ${petTypeFilter}

      GROUP BY post_images."post_id"
      ORDER BY "similarity" DESC
      LIMIT ${options.limit}
    `);

    return rows.map((row) => ({
      postId: row.postId,
      vectorSimilarity: this.clamp(row.similarity ?? 0),
    }));
  }

  /** แยก vector จริงกับ mock และข้อมูลเก่าที่ระบุโหมดไม่ได้ โดยไม่ลบข้อมูลเดิม */
  private storageModel(model: string): string {
    return [
      this.isMockMode() ? 'mock-v2' : 'live-v2',
      model,
      this.configService.get<number>('AI_IMAGE_EMBEDDING_DIMENSION') ?? 768,
    ].join(':');
  }

  private getEmbeddingModel(): string {
    return (
      this.configService.get<string>('AI_IMAGE_EMBEDDING_MODEL') ??
      'mock/image-embedding'
    );
  }

  private async saveEmbedding(
    postImageId: string,
    embedding: number[],
    model: string,
  ): Promise<void> {
    const vector = `[${embedding.join(',')}]`;

    await this.prisma.$executeRaw`
      INSERT INTO "image_embeddings"
      (
        "id",
        "post_image_id",
        "embedding",
        "model_name",
        "dimension",
        "created_at"
      )
      VALUES (
        gen_random_uuid(),
        ${postImageId}::uuid,
        ${vector}::vector,
        ${this.storageModel(model)},
        ${embedding.length},
        NOW()
      )
    `;
  }

  private clamp(value: number): number {
    return Math.max(0, Math.min(1, value));
  }

  private isMockMode(): boolean {
    return this.configService.get<boolean>('AI_MOCK_MODE') ?? true;
  }
}
