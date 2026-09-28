-- AlterTable
ALTER TABLE "Resource" ADD COLUMN     "isAnonymous" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "anonymousByDefault" BOOLEAN NOT NULL DEFAULT false;
