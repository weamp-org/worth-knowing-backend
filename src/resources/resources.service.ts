import { Injectable } from '@nestjs/common';

import { CreateResourceDto } from './dtos/create-resource.dto';
import { UpdateResourceDto } from './dtos/update-resource.dto';

@Injectable()
export class ResourcesService {
  create(createResourceDto: CreateResourceDto) {
    return 'This action adds a new resource';
  }

  findAll() {
    return `This action returns all resource`;
  }

  findOne(id: string) {
    return `This action returns a #${id} resource`;
  }

  update(id: string, updateResourceDto: UpdateResourceDto) {
    return `This action updates a #${id} resource`;
  }

  remove(id: string) {
    return `This action removes a #${id} resource`;
  }
}
