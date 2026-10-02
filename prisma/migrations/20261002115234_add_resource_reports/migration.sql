-- CreateTable
CREATE TABLE "ResourceReport" (
    "reporterId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" VARCHAR(500),

    CONSTRAINT "ResourceReport_pkey" PRIMARY KEY ("resourceId","reporterId")
);

-- CreateIndex
CREATE INDEX "ResourceReport_resourceId_idx" ON "ResourceReport"("resourceId");

-- CreateIndex
CREATE INDEX "ResourceReport_createdAt_reporterId_resourceId_idx" ON "ResourceReport"("createdAt" DESC, "reporterId" DESC, "resourceId" DESC);

-- AddForeignKey
ALTER TABLE "ResourceReport" ADD CONSTRAINT "ResourceReport_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceReport" ADD CONSTRAINT "ResourceReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
