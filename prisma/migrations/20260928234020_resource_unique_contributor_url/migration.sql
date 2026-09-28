/*
  Warnings:

  - A unique constraint covering the columns `[contributorId,url]` on the table `Resource` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "Resource_contributorId_url_key" ON "Resource"("contributorId", "url");
