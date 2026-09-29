-- CreateTable
CREATE TABLE "Collection" (
    "id" TEXT NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "isPrivate" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ownerId" TEXT,

    CONSTRAINT "Collection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionResource" (
    "collectionId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionResource_pkey" PRIMARY KEY ("collectionId","resourceId")
);

-- CreateIndex
CREATE INDEX "Collection_ownerId_createdAt_id_idx" ON "Collection"("ownerId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "CollectionResource_collectionId_addedAt_resourceId_idx" ON "CollectionResource"("collectionId", "addedAt" DESC, "resourceId" DESC);

-- CreateIndex
CREATE INDEX "CollectionResource_resourceId_idx" ON "CollectionResource"("resourceId");

-- AddForeignKey
ALTER TABLE "Collection" ADD CONSTRAINT "Collection_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionResource" ADD CONSTRAINT "CollectionResource_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionResource" ADD CONSTRAINT "CollectionResource_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
