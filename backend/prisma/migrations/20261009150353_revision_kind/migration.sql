-- CreateEnum
CREATE TYPE "RevisionKind" AS ENUM ('AUTO', 'MANUAL', 'RESTORE');

-- AlterTable
ALTER TABLE "document_revisions" ADD COLUMN     "kind" "RevisionKind" NOT NULL DEFAULT 'AUTO',
ADD COLUMN     "restored_from_number" INTEGER;
