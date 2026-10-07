-- CreateTable
CREATE TABLE "CommentReport" (
    "reporterId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" VARCHAR(500),

    CONSTRAINT "CommentReport_pkey" PRIMARY KEY ("reporterId","commentId")
);

-- CreateIndex
CREATE INDEX "CommentReport_commentId_idx" ON "CommentReport"("commentId");

-- CreateIndex
CREATE INDEX "CommentReport_createdAt_reporterId_commentId_idx" ON "CommentReport"("createdAt" DESC, "reporterId" DESC, "commentId" DESC);

-- AddForeignKey
ALTER TABLE "CommentReport" ADD CONSTRAINT "CommentReport_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentReport" ADD CONSTRAINT "CommentReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
