-- CreateTable
CREATE TABLE "SavedResource" (
    "userId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedResource_pkey" PRIMARY KEY ("userId","resourceId")
);

-- CreateIndex
CREATE INDEX "SavedResource_userId_savedAt_resourceId_idx" ON "SavedResource"("userId", "savedAt" DESC, "resourceId" DESC);

-- CreateIndex
CREATE INDEX "SavedResource_resourceId_idx" ON "SavedResource"("resourceId");

-- AddForeignKey
ALTER TABLE "SavedResource" ADD CONSTRAINT "SavedResource_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedResource" ADD CONSTRAINT "SavedResource_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
